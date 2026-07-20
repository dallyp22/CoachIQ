-- Pipeline demo data.
--
-- Fabricated prospects for showing the module to the team. Every row is tagged
-- `[demo]` at the end of its notes so it can never be mistaken for a real lead,
-- and so cleanup is one statement:
--
--     psql "$URL" -f scripts/seed-pipeline-demo-cleanup.sql
--
-- Deliberately creates NO Client rows. Converting a prospect mints a billable
-- record that the invoice crons pick up — the Convert button is here to click
-- live, but nothing is pre-converted.
--
-- Covers every state the UI can render, because a demo that only shows the
-- happy path hides the parts worth showing:
--   · "None scheduled"  (red)    — the neglect signal the sort exists for
--   · overdue           (amber)  — "Nd late"
--   · due today         (accent)
--   · on track          (plain)
--   · hot stages, a won, a lost, and one unassigned
--
-- nextActivityAt is set to match the seeded PLANNED activities exactly, mirroring
-- what refreshNextActivityAt would compute. Seeding them out of sync would make
-- the list and the dossier disagree.
BEGIN;

DO $$
DECLARE
    todd   UUID;
    dallas UUID;
    s_new UUID; s_contacted UUID; s_discovery UUID; s_proposal UUID; s_verbal UUID;
    s_won UUID; s_lost UUID;
    p UUID;
BEGIN
    SELECT id INTO todd   FROM coaches WHERE role = 'OWNER' ORDER BY "createdAt" LIMIT 1;
    SELECT id INTO dallas FROM coaches WHERE "clerkUserId" IS NOT NULL ORDER BY "createdAt" LIMIT 1;
    IF todd IS NULL OR dallas IS NULL THEN
        RAISE EXCEPTION 'Expected an OWNER and a linked coach; found todd=% dallas=%', todd, dallas;
    END IF;

    SELECT id INTO s_new       FROM pipeline_stages WHERE "sortOrder" = 1 AND NOT "isArchived";
    SELECT id INTO s_contacted FROM pipeline_stages WHERE "sortOrder" = 2 AND NOT "isArchived";
    SELECT id INTO s_discovery FROM pipeline_stages WHERE "sortOrder" = 3 AND NOT "isArchived";
    SELECT id INTO s_proposal  FROM pipeline_stages WHERE "sortOrder" = 4 AND NOT "isArchived";
    SELECT id INTO s_verbal    FROM pipeline_stages WHERE "sortOrder" = 5 AND NOT "isArchived";
    SELECT id INTO s_won       FROM pipeline_stages WHERE terminal = 'WON'  AND NOT "isArchived";
    SELECT id INTO s_lost      FROM pipeline_stages WHERE terminal = 'LOST' AND NOT "isArchived";

    -- ── New Lead ────────────────────────────────────────

    -- Fresh but untouched: shows "None scheduled" in red at the very top of the
    -- default sort, which is the behaviour the whole module is built around.
    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,phone,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, NULL, 'Priya','Raghunathan','Kestrel Analytics','COACHING',
            'Newly promoted CTO, first time managing directors. Referred by a former client.',
            'priya@example.com','(402) 555-0148', s_new, NOW() - INTERVAL '3 days', NULL,
            'Came in through the website form. [demo]', NOW() - INTERVAL '3 days', NOW())
    RETURNING id INTO p;

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, todd, 'Tom','Bradfield','Halden Group','FACILITATION',
            'Wants a facilitated offsite for a leadership team that just absorbed an acquisition.',
            'tbradfield@example.com', s_new, NOW() - INTERVAL '5 days', NOW() + INTERVAL '2 days',
            'Budget approved, timing unclear. [demo]', NOW() - INTERVAL '5 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '4 days','Intro call. Team of 9, offsite penciled for the autumn.', todd, NOW() - INTERVAL '4 days', NOW()),
      (p,'PLANNED',NOW() + INTERVAL '2 days','Send the facilitation outline and two date options.', todd, NULL, NOW());

    -- ── Contacted ───────────────────────────────────────

    -- Overdue: amber, with "4d late".
    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, dallas, 'Marcus','Lee','Aperture Health','COACHING',
            'VP Ops struggling to delegate after doubling headcount.',
            'mlee@example.com', s_contacted, NOW() - INTERVAL '11 days', NOW() - INTERVAL '4 days',
            'Slow to reply — try his assistant. [demo]', NOW() - INTERVAL '22 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '20 days','Referred by Aperture''s CFO. Left a voicemail.', todd, NOW() - INTERVAL '20 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '12 days','Connected. 30 min. Real appetite, no timeline yet.', todd, NOW() - INTERVAL '12 days', NOW()),
      (p,'PLANNED',NOW() - INTERVAL '4 days','Follow up on the engagement outline.', dallas, NULL, NOW());

    -- Due today: accent.
    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, todd, 'Sandra','Okonkwo','Rivet Manufacturing','IMPLEMENTATION',
            'Rolling out a new ops cadence across three plants; wants help making it stick.',
            'sokonkwo@example.com', s_contacted, NOW() - INTERVAL '6 days', date_trunc('day', NOW()) + INTERVAL '15 hours',
            'Plant managers are the real stakeholders. [demo]', NOW() - INTERVAL '14 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '13 days','Inbound via LinkedIn.', todd, NOW() - INTERVAL '13 days', NOW()),
      (p,'PLANNED',date_trunc('day', NOW()) + INTERVAL '15 hours','Call with the two plant managers.', todd, NULL, NOW());

    -- ── Discovery Scheduled (HOT) ───────────────────────

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,phone,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, todd, 'Dana','Whitfield','Northwind Logistics','COACHING',
            'Wants exec coaching for a newly promoted VP who is struggling to hold her team accountable.',
            'dana@example.com','(312) 555-0173', s_discovery, NOW() - INTERVAL '8 days', NOW() + INTERVAL '3 days',
            'Strongest lead this quarter. [demo]', NOW() - INTERVAL '31 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '30 days','Met at the NEBA leadership breakfast.', todd, NOW() - INTERVAL '30 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '24 days','Intro call. Six-month engagement, bi-weekly.', todd, NOW() - INTERVAL '24 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '9 days','Sent the proposal and two references.', todd, NOW() - INTERVAL '9 days', NOW()),
      (p,'PLANNED',NOW() + INTERVAL '3 days','Discovery session with Dana and the VP.', todd, NULL, NOW());

    -- Hot AND neglected: the combination the Hot Prospects report exists to catch.
    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, dallas, 'Elliot','Vance','Corvus Media','MULTIPLE',
            'Coaching for two founders plus facilitation for their combined leadership team.',
            'evance@example.com', s_discovery, NOW() - INTERVAL '21 days', NULL,
            'Went quiet after the pricing conversation. [demo]', NOW() - INTERVAL '45 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '44 days','Referred by Gregory at Alder & Finch.', todd, NOW() - INTERVAL '44 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '30 days','Long call with both founders. Genuine fit.', todd, NOW() - INTERVAL '30 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '21 days','Walked through pricing. They asked for time.', dallas, NOW() - INTERVAL '21 days', NOW());

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (dallas, dallas, 'Naomi','Feldstein','Brightpath Education','FACILITATION',
            'Board retreat facilitation ahead of a strategic plan refresh.',
            'nfeldstein@example.com', s_discovery, NOW() - INTERVAL '4 days', NOW() + INTERVAL '6 days',
            'Board chair is the decision maker. [demo]', NOW() - INTERVAL '19 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '18 days','Intro email from a mutual contact.', dallas, NOW() - INTERVAL '18 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '5 days','Call with the ED. Retreat is in October.', dallas, NOW() - INTERVAL '5 days', NOW()),
      (p,'PLANNED',NOW() + INTERVAL '6 days','Discovery call with the board chair.', dallas, NULL, NOW());

    -- ── Proposal / In Discussion (HOT) ──────────────────

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, todd, 'Raj','Patel','Meridian Freight','COACHING',
            'Second-generation owner taking over from his father; wants a sounding board through the transition.',
            'rpatel@example.com', s_proposal, NOW() - INTERVAL '16 days', NOW() - INTERVAL '2 days',
            'Proposal out, waiting on his father''s sign-off. [demo]', NOW() - INTERVAL '52 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '51 days','Introduced by his banker.', todd, NOW() - INTERVAL '51 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '38 days','Discovery. Succession is the whole conversation.', todd, NOW() - INTERVAL '38 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '17 days','Proposal sent — 12 months, monthly.', todd, NOW() - INTERVAL '17 days', NOW()),
      (p,'PLANNED',NOW() - INTERVAL '2 days','Check in on the proposal.', todd, NULL, NOW());

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, dallas, 'Claire','Beaumont','Stonebridge Capital','COACHING',
            'Managing partner wants coaching for three rising directors as a cohort.',
            'cbeaumont@example.com', s_proposal, NOW() - INTERVAL '9 days', NOW() + INTERVAL '1 day',
            'Cohort pricing — three at once. [demo]', NOW() - INTERVAL '38 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '37 days','Inbound. Found us through the podcast.', dallas, NOW() - INTERVAL '37 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '10 days','Scoping call. Cohort of three, six months.', dallas, NOW() - INTERVAL '10 days', NOW()),
      (p,'PLANNED',NOW() + INTERVAL '1 day','Present the cohort proposal.', dallas, NULL, NOW());

    -- ── Verbal Commit (HOT) ─────────────────────────────

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, todd, 'Gregory','Vance','Alder & Finch','COACHING',
            'Wants coaching for his incoming COO, starting once she is in seat.',
            'gvance@example.com', s_verbal, NOW() - INTERVAL '5 days', NOW() + INTERVAL '4 days',
            'Verbal yes. Waiting on her start date. [demo]', NOW() - INTERVAL '67 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '66 days','Long-standing contact. Reached out directly.', todd, NOW() - INTERVAL '66 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '40 days','Discovery. Clear on what he wants.', todd, NOW() - INTERVAL '40 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '6 days','Verbal commitment. Contract to follow.', todd, NOW() - INTERVAL '6 days', NOW()),
      (p,'PLANNED',NOW() + INTERVAL '4 days','Send the agreement once her start date lands.', todd, NULL, NOW());

    -- ── Unassigned ──────────────────────────────────────

    -- Nobody has picked this up — the state that vanishes if scoping filters on
    -- assignment alone.
    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, NULL, 'Amara','Nwosu','Vertex Bio','COACHING',
            'Head of R&D moving into a general management seat for the first time.',
            NULL, s_contacted, NOW() - INTERVAL '9 days', NULL,
            'No email yet — came through a conference badge scan. [demo]', NOW() - INTERVAL '9 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '9 days','Met at the BIO conference. Needs an owner.', NULL, NOW() - INTERVAL '9 days', NOW());

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (dallas, todd, 'Simon','Achterberg','Kite & Rowe','FACILITATION',
            'Annual partner retreat; last year''s ran long and landed flat.',
            'sachterberg@example.com', s_contacted, NOW() - INTERVAL '12 days', NOW() + INTERVAL '8 days',
            'Wants a different feel from last year. [demo]', NOW() - INTERVAL '27 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '26 days','Repeat enquiry from last year.', dallas, NOW() - INTERVAL '26 days', NOW()),
      (p,'PLANNED',NOW() + INTERVAL '8 days','Call to scope the retreat agenda.', todd, NULL, NOW());

    -- ── Closed ──────────────────────────────────────────

    -- Won but NOT converted: the Convert button stays live to click in the demo.
    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt",notes,"createdAt","updatedAt")
    VALUES (todd, todd, 'Yuki','Tanaka','Lumen Robotics','COACHING',
            'Coaching for a founder-CEO scaling past 100 people.',
            'ytanaka@example.com', s_won, NOW() - INTERVAL '2 days', NULL,
            'Closed. Ready to convert to a client. [demo]', NOW() - INTERVAL '90 days', NOW())
    RETURNING id INTO p;
    INSERT INTO pipeline_activities ("prospectId",kind,"activityAt",notes,"ownerId","completedAt","updatedAt") VALUES
      (p,'LOGGED', NOW() - INTERVAL '88 days','Introduced by a portfolio company CEO.', todd, NOW() - INTERVAL '88 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '60 days','Discovery. Strong fit.', todd, NOW() - INTERVAL '60 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '20 days','Proposal accepted.', todd, NOW() - INTERVAL '20 days', NOW()),
      (p,'LOGGED', NOW() - INTERVAL '2 days','Signed. Starting next month.', todd, NOW() - INTERVAL '2 days', NOW());

    INSERT INTO prospects ("coachId","assignedCoachId","firstName","lastName",company,"opportunityType","needSummary",email,"stageId","stageEnteredAt","nextActivityAt","lostReason",notes,"createdAt","updatedAt")
    VALUES (todd, todd, 'Devon','Mercer','Pinecrest Partners','COACHING',
            'Wanted coaching for two principals ahead of a merger.',
            'dmercer@example.com', s_lost, NOW() - INTERVAL '15 days', NULL,
            'Went with an internal coach their PE sponsor provided.',
            'Worth revisiting after the merger settles. [demo]', NOW() - INTERVAL '74 days', NOW());

END $$;

-- Stage history, so the dossier timelines show how each prospect got where it is
-- rather than appearing to have materialised in place.
INSERT INTO prospect_stage_changes ("prospectId","fromStageId","toStageId","changedAt","changedById")
SELECT p.id, NULL, (SELECT id FROM pipeline_stages WHERE "sortOrder" = 1), p."createdAt", p."coachId"
FROM prospects p WHERE p.notes LIKE '%[demo]%';

INSERT INTO prospect_stage_changes ("prospectId","fromStageId","toStageId","changedAt","changedById")
SELECT p.id, (SELECT id FROM pipeline_stages WHERE "sortOrder" = 1), p."stageId", p."stageEnteredAt", p."coachId"
FROM prospects p
WHERE p.notes LIKE '%[demo]%' AND p."stageId" <> (SELECT id FROM pipeline_stages WHERE "sortOrder" = 1);

COMMIT;
