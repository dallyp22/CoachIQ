import { describe, it, expect } from "vitest";
import { splitRow, splitName, parsePasted } from "@/app/(dashboard)/pipeline/add-prospect";

/**
 * The paste importer is the flow the module's day-one value rests on: Todd
 * already keeps a tracker, and if pasting it in garbles the data he will not
 * use the module. These are pure functions, so they need no DOM.
 */

describe("splitRow", () => {
  it("splits a plain comma row", () => {
    expect(splitRow("Dana Whitfield, Northwind, Wants coaching, dana@nw.com")).toEqual([
      "Dana Whitfield",
      "Northwind",
      "Wants coaching",
      "dana@nw.com",
    ]);
  });

  it("keeps a quoted company containing a comma as ONE field", () => {
    // The regression: an unquoted comma in "Acme, Inc" shifted every later
    // column — need became "Inc" and email became the need text. Silent, and
    // on the one flow that has to work first time.
    expect(splitRow('Marcus Lee, "Aperture Health, Inc", Team offsite, m@ap.com')).toEqual([
      "Marcus Lee",
      "Aperture Health, Inc",
      "Team offsite",
      "m@ap.com",
    ]);
  });

  it("splits on tabs only when the line contains any tab", () => {
    // A direct paste from Sheets is tab-delimited and its cells routinely
    // contain commas — splitting on those too would shred every row.
    expect(splitRow("Dana Whitfield\tAperture Health, Inc\tWants coaching\td@ap.com")).toEqual([
      "Dana Whitfield",
      "Aperture Health, Inc",
      "Wants coaching",
      "d@ap.com",
    ]);
  });

  it("handles a doubled quote inside a quoted field as a literal quote", () => {
    // RFC 4180: "" is an escaped quote only WITHIN a quoted field, which is
    // what a spreadsheet emits when a cell contains a quote character.
    expect(splitRow('Ann Marie, "The ""Big"" Co", needs help')).toEqual([
      "Ann Marie",
      'The "Big" Co',
      "needs help",
    ]);
  });

  it("strips stray quotes in an unquoted field rather than mangling the row", () => {
    // Not valid CSV, but people paste it. Losing the quote marks is a far
    // better outcome than shifting every subsequent column.
    expect(splitRow('Ann Marie, The "Big" Co, needs help')).toEqual([
      "Ann Marie",
      "The Big Co",
      "needs help",
    ]);
  });

  it("trims surrounding whitespace on every field", () => {
    expect(splitRow("  Dana  ,   Northwind  ,  needs help  ")).toEqual([
      "Dana",
      "Northwind",
      "needs help",
    ]);
  });

  it("returns a single field for a bare name", () => {
    expect(splitRow("Cher")).toEqual(["Cher"]);
  });

  it("preserves empty middle fields rather than collapsing them", () => {
    // "Name,,,email" means no company and no need — the email must stay in
    // position 4, not slide up to position 2.
    expect(splitRow("Dana Whitfield,,,dana@nw.com")).toEqual([
      "Dana Whitfield",
      "",
      "",
      "dana@nw.com",
    ]);
  });
});

describe("splitName", () => {
  it("keeps a multi-part first name together", () => {
    expect(splitName("Mary Jo Smith")).toEqual({ firstName: "Mary Jo", lastName: "Smith" });
  });

  it("handles a simple two-part name", () => {
    expect(splitName("Dana Whitfield")).toEqual({ firstName: "Dana", lastName: "Whitfield" });
  });

  it("puts a single token in firstName, not lastName", () => {
    // A mononym is a first name with no surname, not a surname with no first
    // name — the row renders as "Cher", not " Cher".
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
  });

  it("collapses runs of whitespace", () => {
    expect(splitName("  Dana   Whitfield  ")).toEqual({
      firstName: "Dana",
      lastName: "Whitfield",
    });
  });

  it("returns empty strings for empty input rather than throwing", () => {
    expect(splitName("")).toEqual({ firstName: "", lastName: "" });
    expect(splitName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("parsePasted", () => {
  it("parses a multi-line tracker", () => {
    const rows = parsePasted(
      "Dana Whitfield, Northwind Logistics, Wants exec coaching, dana@northwind.com\n" +
        "Marcus Lee, Aperture Health, Team offsite facilitation",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      firstName: "Dana",
      lastName: "Whitfield",
      company: "Northwind Logistics",
      needSummary: "Wants exec coaching",
      email: "dana@northwind.com",
    });
    expect(rows[1].email).toBeUndefined();
  });

  it("drops blank and whitespace-only lines", () => {
    expect(parsePasted("Dana Whitfield\n\n   \n\nMarcus Lee")).toHaveLength(2);
  });

  it("survives a row with only a name", () => {
    expect(parsePasted("Cher")).toEqual([
      { firstName: "Cher", lastName: "", company: undefined, needSummary: undefined, email: undefined },
    ]);
  });

  it("does not shift columns when a company contains a quoted comma", () => {
    const [row] = parsePasted('Marcus Lee, "Aperture Health, Inc", Team offsite, m@ap.com');
    expect(row.company).toBe("Aperture Health, Inc");
    expect(row.needSummary).toBe("Team offsite");
    expect(row.email).toBe("m@ap.com");
  });

  it("ignores extra columns beyond the fourth rather than failing the row", () => {
    const [row] = parsePasted("Dana W, Northwind, needs help, d@nw.com, 555-1234, extra");
    expect(row.firstName).toBe("Dana");
    expect(row.email).toBe("d@nw.com");
  });

  it("returns an empty list for empty input", () => {
    expect(parsePasted("")).toEqual([]);
    expect(parsePasted("\n\n  \n")).toEqual([]);
  });
});
