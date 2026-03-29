-- Add vector column for transcript embeddings (OpenAI text-embedding-3-small, 1536 dimensions)
ALTER TABLE "transcripts" ADD COLUMN "embedding" vector(1536);

-- Create IVFFlat index for approximate nearest-neighbor search
-- Using 100 lists as default; rebuild with more lists when transcript count exceeds 10K
CREATE INDEX "transcripts_embedding_idx" ON "transcripts" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- Create full-text search column and GIN index
ALTER TABLE "transcripts" ADD COLUMN "search_text" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "fullText")) STORED;
CREATE INDEX "transcripts_search_text_idx" ON "transcripts" USING gin ("search_text");
