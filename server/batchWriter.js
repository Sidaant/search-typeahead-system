export class BatchWriter {
  constructor(db, flushIntervalMs = 5000, maxBufferSize = 20) {
    this.db = db;
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.buffer = new Map(); // query -> incrementCount
    this.totalSubmissions = 0;
    this.totalBufferedCount = 0;
    this.flushesCount = 0;
    this.savedWrites = 0;
    this.timer = null;
  }

  // Start the periodic flush timer
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    console.log(`BatchWriter started with flush interval of ${this.flushIntervalMs}ms`);
  }

  // Stop the periodic flush timer
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Add a search query to the buffer
  addQuery(query) {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) return;

    this.totalSubmissions++;
    this.totalBufferedCount++;
    
    // Aggregate queries in memory
    const currentVal = this.buffer.get(cleanQuery) || 0;
    this.buffer.set(cleanQuery, currentVal + 1);

    // If total buffered count exceeds max buffer size, flush immediately
    if (this.totalBufferedCount >= this.maxBufferSize) {
      console.log(`Buffer limit (${this.maxBufferSize}) reached, flushing immediately...`);
      this.flush();
    }
  }

  // Flush aggregated buffer to database
  flush() {
    if (this.buffer.size === 0) return;

    const uniqueKeysCount = this.buffer.size;
    const batchTotalCount = this.totalBufferedCount;
    
    console.log(`Flushing batch of ${batchTotalCount} searches (${uniqueKeysCount} unique queries) to database...`);
    
    // Update the database in a single batch
    this.db.batchUpdate(this.buffer);

    // Calculate writes saved:
    // Without batching, we would write to disk for every single search submission (batchTotalCount times).
    // With batching, we perform exactly 1 update/write.
    // So the writes saved is batchTotalCount - 1.
    this.savedWrites += (batchTotalCount - 1);
    
    // Reset buffer
    this.buffer.clear();
    this.totalBufferedCount = 0;
    this.flushesCount++;
  }

  // Get metrics and stats
  getStats() {
    return {
      pendingCount: this.totalBufferedCount,
      pendingUnique: this.buffer.size,
      totalSubmissions: this.totalSubmissions,
      flushesCount: this.flushesCount,
      savedWrites: this.savedWrites,
      writeReductionRatio: this.totalSubmissions === 0 ? 0 : this.savedWrites / this.totalSubmissions
    };
  }
}
