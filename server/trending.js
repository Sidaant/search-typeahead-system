export class TrendingTracker {
  constructor(windowDurationMs = 2 * 60 * 1000) { // Default: 2 minutes sliding window for easy demo
    this.windowDurationMs = windowDurationMs;
    this.recentSearches = []; // Array of { query, timestamp }
  }

  // Record a search submission
  recordSearch(query) {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) return;
    this.recentSearches.push({ query: cleanQuery, timestamp: Date.now() });
    this.cleanup();
  }

  // Remove entries outside the sliding window
  cleanup() {
    const cutoff = Date.now() - this.windowDurationMs;
    // Since timestamp is increasing, we can find the index where timestamp >= cutoff
    let firstValidIdx = 0;
    while (firstValidIdx < this.recentSearches.length && this.recentSearches[firstValidIdx].timestamp < cutoff) {
      firstValidIdx++;
    }
    if (firstValidIdx > 0) {
      this.recentSearches.splice(0, firstValidIdx);
    }
  }

  // Get aggregated counts of queries in the recent window
  getRecentCounts(prefix = '') {
    this.cleanup();
    const counts = new Map();
    const cleanPrefix = prefix.trim().toLowerCase();

    for (const entry of this.recentSearches) {
      if (cleanPrefix && !entry.query.startsWith(cleanPrefix)) {
        continue;
      }
      counts.set(entry.query, (counts.get(entry.query) || 0) + 1);
    }
    return counts;
  }

  // Rank suggestions incorporating recency
  // Candidates is an array of { query, count } from the primary database
  rankSuggestions(candidates, prefix = '', weight = 5000) {
    const recentCounts = this.getRecentCounts(prefix);
    const scoredMap = new Map();

    // 1. Add all candidates from the database
    for (const c of candidates) {
      scoredMap.set(c.query, {
        query: c.query,
        historicalCount: c.count,
        recentCount: 0,
        score: c.count
      });
    }

    // 2. Add/merge recent searches from the sliding window (handles brand new queries too!)
    for (const [query, recentCount] of recentCounts.entries()) {
      if (scoredMap.has(query)) {
        const entry = scoredMap.get(query);
        entry.recentCount = recentCount;
        entry.score = entry.historicalCount + (recentCount * weight);
      } else {
        scoredMap.set(query, {
          query: query,
          historicalCount: 0,
          recentCount: recentCount,
          score: recentCount * weight
        });
      }
    }

    // Convert to array and sort by score descending
    const results = Array.from(scoredMap.values());
    results.sort((a, b) => b.score - a.score || a.query.localeCompare(b.query));

    // Format output to match basic suggestion items
    return results.slice(0, 10).map(r => ({
      query: r.query,
      count: r.historicalCount, // show historical count
      recentCount: r.recentCount,
      score: r.score,
      trending: r.recentCount > 0
    }));
  }

  // Get top trending searches overall (for the "trending now" section)
  getTrendingNow(limit = 5) {
    this.cleanup();
    const recentCounts = this.getRecentCounts();
    const sorted = Array.from(recentCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(entry => ({ query: entry[0], recentCount: entry[1] }));
    return sorted;
  }
}
