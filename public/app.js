// API Base URL (assumes server runs on same host/port)
const API_BASE = window.location.origin;

// State variables
let activeSuggestionIdx = -1;
let currentSuggestions = [];
let debounceTimer = null;
let lastPrefix = '';
let activeRouteDebug = null;
let lastCacheStatus = null;
let submissionLog = []; // items: { query, timestamp, status: 'queued' | 'flushed' }
let nodeColors = {
  'CacheNode_1': '#6366f1', // Indigo
  'CacheNode_2': '#10b981', // Emerald
  'CacheNode_3': '#f43f5e', // Rose
  'CacheNode_4': '#f59e0b'  // Amber
};

// DOM Elements
const searchInput = document.getElementById('search-input');
const suggestionsList = document.getElementById('suggestions-list');
const clearBtn = document.getElementById('clear-btn');
const searchBtn = document.getElementById('search-btn');
const rankingModeToggle = document.getElementById('ranking-mode-toggle');
const searchLogContainer = document.getElementById('search-log');
const trendingListContainer = document.getElementById('trending-list');

// Metric Elements
const metricLatencyP95 = document.getElementById('metric-latency-p95');
const metricLatencyAvg = document.getElementById('metric-latency-avg');
const metricHitRate = document.getElementById('metric-hit-rate');
const metricHitMissRatio = document.getElementById('metric-hit-miss-ratio');
const metricWritesSaved = document.getElementById('metric-writes-saved');
const metricWritesReduction = document.getElementById('metric-writes-reduction');
const routingDebugInfo = document.getElementById('routing-debug-info');
const nodesListContainer = document.getElementById('nodes-list');

// Simulation Elements
const btnSimulateNormal = document.getElementById('btn-simulate-normal');
const btnSimulateTrending = document.getElementById('btn-simulate-trending');
const simulationStatus = document.getElementById('simulation-status');
const btnFlushCaches = document.getElementById('btn-flush-caches');

// Canvas Setup
const canvas = document.getElementById('ring-canvas');
const ctx = canvas.getContext('2d');
let ringLayout = [];

// --- 1. SEARCH BOX & SUGGESTIONS LOGIC ---

// Event Listeners
searchInput.addEventListener('input', handleSearchInput);
searchInput.addEventListener('keydown', handleSearchKeydown);
clearBtn.addEventListener('click', clearSearch);
searchBtn.addEventListener('click', submitSearch);
btnFlushCaches.addEventListener('click', flushCaches);
rankingModeToggle.addEventListener('change', () => {
  // Re-trigger suggest if there is input
  if (searchInput.value.trim()) {
    fetchSuggestions(searchInput.value.trim());
  }
});

// Close suggestions dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box-wrapper')) {
    hideSuggestions();
  }
});

function handleSearchInput(e) {
  const value = e.target.value;
  
  if (value.length > 0) {
    clearBtn.classList.remove('hidden');
  } else {
    clearBtn.classList.add('hidden');
    hideSuggestions();
    return;
  }

  // Debounce API calls (200ms)
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    fetchSuggestions(value);
  }, 200);
}

// Fetch suggestions from Express API
async function fetchSuggestions(prefix) {
  if (!prefix.trim()) return;
  
  const mode = rankingModeToggle.checked ? 'trending' : 'basic';
  lastPrefix = prefix;

  try {
    const res = await fetch(`${API_BASE}/suggest?q=${encodeURIComponent(prefix)}&mode=${mode}`);
    const data = await res.json();
    
    currentSuggestions = data.suggestions || [];
    activeRouteDebug = data.cache;
    lastCacheStatus = data.cache.status;
    
    renderSuggestions(prefix);
    
    // Instantly update routing visualizer debug info
    updateRoutingText(prefix, data.cache);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
  }
}

// Render dynamic suggestions dropdown list
function renderSuggestions(prefix) {
  suggestionsList.innerHTML = '';
  activeSuggestionIdx = -1;

  if (currentSuggestions.length === 0) {
    hideSuggestions();
    return;
  }

  currentSuggestions.forEach((item, index) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('id', `suggestion-item-${index}`);
    
    // Highlight matching prefix
    const queryStr = item.query;
    let textHTML = queryStr;
    const cleanPrefix = prefix.toLowerCase();
    
    if (queryStr.toLowerCase().startsWith(cleanPrefix)) {
      const matchPart = queryStr.substring(0, prefix.length);
      const remainingPart = queryStr.substring(prefix.length);
      textHTML = `<strong>${escapeHTML(matchPart)}</strong>${escapeHTML(remainingPart)}`;
    } else {
      textHTML = escapeHTML(queryStr);
    }

    li.innerHTML = `
      <span class="suggestion-text">${textHTML}</span>
      <div class="suggestion-meta">
        ${item.trending ? '<span class="trending-badge">Trending</span>' : ''}
        <span class="suggestion-count">${formatNumber(item.count)}</span>
      </div>
    `;

    li.addEventListener('click', () => {
      searchInput.value = item.query;
      submitSearch();
    });

    suggestionsList.appendChild(li);
  });

  suggestionsList.classList.remove('hidden');
}

function hideSuggestions() {
  suggestionsList.classList.add('hidden');
  suggestionsList.innerHTML = '';
  currentSuggestions = [];
  activeSuggestionIdx = -1;
}

function clearSearch() {
  searchInput.value = '';
  clearBtn.classList.add('hidden');
  hideSuggestions();
  searchInput.focus();
}

// Handle keyboard navigation inside dropdown list
function handleSearchKeydown(e) {
  const items = suggestionsList.querySelectorAll('li');
  
  if (suggestionsList.classList.contains('hidden') || items.length === 0) {
    if (e.key === 'Enter') {
      submitSearch();
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSuggestionIdx = (activeSuggestionIdx + 1) % items.length;
    highlightSuggestion(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestionIdx = (activeSuggestionIdx - 1 + items.length) % items.length;
    highlightSuggestion(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeSuggestionIdx >= 0 && activeSuggestionIdx < currentSuggestions.length) {
      searchInput.value = currentSuggestions[activeSuggestionIdx].query;
    }
    submitSearch();
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
}

function highlightSuggestion(items) {
  items.forEach((item, idx) => {
    if (idx === activeSuggestionIdx) {
      item.classList.add('active');
      searchInput.value = currentSuggestions[idx].query;
      searchInput.setAttribute('aria-activedescendant', `suggestion-item-${idx}`);
    } else {
      item.classList.remove('active');
    }
  });
}

// Submit search query to POST /search API
async function submitSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  hideSuggestions();

  // Create submission record and mark as queued (writing to buffer)
  const logId = Date.now() + Math.random().toString(36).substr(2, 5);
  const logItem = {
    id: logId,
    query: query,
    timestamp: new Date().toLocaleTimeString(),
    status: 'queued'
  };

  submissionLog.unshift(logItem);
  if (submissionLog.length > 10) submissionLog.pop(); // keep last 10 log items
  renderSearchLog();

  try {
    const res = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    
    const data = await res.json();
    
    // Notify user of search success
    console.log('Search submission registered:', data);
  } catch (error) {
    console.error('Error submitting search:', error);
  }
}

function renderSearchLog() {
  searchLogContainer.innerHTML = '';
  
  if (submissionLog.length === 0) {
    searchLogContainer.innerHTML = '<div class="empty-log-message">No searches submitted yet. Submit a search to see the batching mechanism activate.</div>';
    return;
  }

  submissionLog.forEach(item => {
    const el = document.createElement('div');
    el.className = 'log-item';
    
    const statusText = item.status === 'queued' ? 'Queued' : 'Flushed &amp; Saved';
    const statusClass = item.status === 'queued' ? 'queued' : 'flushed';
    
    el.innerHTML = `
      <span class="log-query">${escapeHTML(item.query)}</span>
      <div class="log-details">
        <span class="log-time">${item.timestamp}</span>
        <span class="log-badge ${statusClass}">${statusText}</span>
      </div>
    `;
    
    searchLogContainer.appendChild(el);
  });
}

// --- 2. METRICS & MONITORING DASHBOARD ---

// Poll metrics server endpoint every 1000ms
async function pollMetrics() {
  try {
    const res = await fetch(`${API_BASE}/metrics`);
    const metrics = await res.json();
    
    // Save ring layout for canvas renderer
    ringLayout = metrics.ringLayout || [];
    
    // Update live metrics cards
    updateMetricsCards(metrics);
    
    // Update trending list section
    updateTrendingNowList(metrics.trendingNow);
    
    // Update cache nodes list panel
    updateCacheNodesPanel(metrics.cacheNodes);
    
    // Check batch writer buffer to see if queued submissions have flushed
    updateQueuedSubmissionsStatus(metrics.batchWriter.pendingCount);
    
  } catch (error) {
    console.error('Error polling metrics:', error);
  }
}

function updateMetricsCards(metrics) {
  // Latency Card
  metricLatencyP95.innerText = `${metrics.latency.p95.toFixed(2)} ms`;
  metricLatencyAvg.innerHTML = `Avg: ${metrics.latency.avg.toFixed(2)} ms | p99: ${metrics.latency.p99.toFixed(2)} ms`;
  
  // Cache Hit Rate Card
  const totalRequests = metrics.cacheNodes.reduce((acc, node) => acc + node.hits + node.misses, 0);
  const totalHits = metrics.cacheNodes.reduce((acc, node) => acc + node.hits, 0);
  const totalMisses = metrics.cacheNodes.reduce((acc, node) => acc + node.misses, 0);
  const hitPercentage = totalRequests === 0 ? 0 : (totalHits / totalRequests) * 100;
  
  metricHitRate.innerText = `${hitPercentage.toFixed(1)}%`;
  metricHitMissRatio.innerText = `Hits: ${formatNumber(totalHits)} | Misses: ${formatNumber(totalMisses)}`;
  
  // Writes Saved Card
  metricWritesSaved.innerText = formatNumber(metrics.batchWriter.savedWrites);
  const reductionPercentage = metrics.batchWriter.writeReductionRatio * 100;
  metricWritesReduction.innerText = `${reductionPercentage.toFixed(1)}% write reduction`;
}

function updateTrendingNowList(trendingNow) {
  trendingListContainer.innerHTML = '';
  
  if (!trendingNow || trendingNow.length === 0) {
    trendingListContainer.innerHTML = '<div class="empty-trending">No trending searches yet. Submit searches repeatedly to make queries trend!</div>';
    return;
  }

  trendingNow.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'trending-item';
    el.innerHTML = `
      <div>
        <span class="trending-rank">#${index + 1}</span>
        <span class="trending-query">${escapeHTML(item.query)}</span>
      </div>
      <span class="trending-count">${item.recentCount} recent searches</span>
    `;
    
    el.addEventListener('click', () => {
      searchInput.value = item.query;
      submitSearch();
    });
    
    trendingListContainer.appendChild(el);
  });
}

function updateCacheNodesPanel(nodes) {
  nodesListContainer.innerHTML = '';
  
  nodes.forEach((node, i) => {
    const nodeEl = document.createElement('div');
    nodeEl.className = `node-item node-${i + 1}`;
    
    const nodeColor = nodeColors[node.nodeId] || '#ffffff';
    const percentFilled = (node.size / node.maxSize) * 100;
    
    nodeEl.innerHTML = `
      <div class="node-item-header">
        <span class="node-name" style="color: ${nodeColor}">${node.nodeId}</span>
        <span class="node-stats">${node.size} / ${node.maxSize} keys</span>
      </div>
      <div class="node-progress-bar">
        <div class="node-progress-fill" style="width: ${percentFilled}%"></div>
      </div>
      <div class="node-item-header" style="margin-top: 0.15rem; font-size: 0.72rem; color: var(--text-muted)">
        <span>Hit Rate: ${(node.hitRate * 100).toFixed(1)}%</span>
        <span>Hits: ${node.hits} | Miss: ${node.misses}</span>
      </div>
    `;
    
    nodesListContainer.appendChild(nodeEl);
  });
}

// Mark search logs as flushed when the backend queue is empty
function updateQueuedSubmissionsStatus(pendingCount) {
  if (pendingCount === 0) {
    submissionLog.forEach(item => {
      if (item.status === 'queued') {
        item.status = 'flushed';
      }
    });
    renderSearchLog();
  }
}

// Update text in the center circle of the Consistent Hash Ring
function updateRoutingText(prefix, cacheInfo) {
  if (!prefix) {
    routingDebugInfo.innerHTML = 'Hover or type a prefix to see routing';
    return;
  }
  
  const color = nodeColors[cacheInfo.nodeId] || '#ffffff';
  const badgeClass = cacheInfo.status === 'hit' ? 'trending-badge' : 'log-badge';
  const badgeText = cacheInfo.status.toUpperCase();
  
  routingDebugInfo.innerHTML = `
    <div style="font-size: 0.7rem; color: var(--text-muted);">PREFIX: "${escapeHTML(prefix)}"</div>
    <div style="font-size: 0.65rem; color: ${color}; margin-top: 0.1rem;">HASH: 0x${cacheInfo.keyHash.toString(16).toUpperCase()}</div>
    <div class="routing-debug-node" style="color: ${color}">${cacheInfo.nodeId}</div>
    <div style="margin-top: 0.25rem;"><span class="${badgeClass}" style="${cacheInfo.status === 'hit' ? 'background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);' : ''}">${badgeText}</span></div>
  `;
}

// --- 3. TRAFFIC SIMULATOR ---

btnSimulateNormal.addEventListener('click', () => runSimulation('normal'));
btnSimulateTrending.addEventListener('click', () => runSimulation('trending'));

async function runSimulation(type) {
  btnSimulateNormal.disabled = true;
  btnSimulateTrending.disabled = true;
  simulationStatus.innerText = 'Simulating traffic...';
  
  try {
    const res = await fetch(`${API_BASE}/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 100, type })
    });
    const data = await res.json();
    
    simulationStatus.innerText = `Simulated 100 searches. (e.g. "${data.queriesSample.join('", "')}")`;
    
    // Add simulated queries to local submission log to show real-time batching flush
    data.queriesSample.forEach(q => {
      submissionLog.unshift({
        id: Date.now() + Math.random().toString(36).substr(2, 5),
        query: q,
        timestamp: new Date().toLocaleTimeString(),
        status: 'queued'
      });
    });
    if (submissionLog.length > 10) submissionLog.splice(10);
    renderSearchLog();
    
  } catch (error) {
    simulationStatus.innerText = 'Simulation failed.';
    console.error('Simulation error:', error);
  } finally {
    setTimeout(() => {
      btnSimulateNormal.disabled = false;
      btnSimulateTrending.disabled = false;
    }, 1000);
  }
}

async function flushCaches() {
  btnFlushCaches.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/cache/flush`, { method: 'POST' });
    const data = await res.json();
    console.log(data.message);
    
    // Reset local cache UI state
    activeRouteDebug = null;
    lastCacheStatus = null;
    updateRoutingText('', null);
    
    // Instantly update metrics to show 0 size nodes
    pollMetrics();
  } catch (error) {
    console.error('Error flushing caches:', error);
  } finally {
    setTimeout(() => {
      btnFlushCaches.disabled = false;
    }, 500);
  }
}

// --- 4. CONSISTENT HASH RING CANVAS RENDERER ---

function drawRing() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = 120;
  
  // 1. Draw Hash Ring track
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 8;
  ctx.stroke();
  
  // Return if layout hasn't loaded
  if (ringLayout.length === 0) return;
  
  // 2. Draw Virtual Nodes as tiny colored dots along the track
  ringLayout.forEach(vNode => {
    const angle = vNode.angle - Math.PI / 2; // Subtract 90 degrees to make 0 o'clock the start
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = nodeColors[vNode.nodeId] || '#ffffff';
    ctx.fill();
  });
  
  // 3. Draw Physical Node Labels nicely spaced inside the ring
  const physicalNodeNames = ['CacheNode_1', 'CacheNode_2', 'CacheNode_3', 'CacheNode_4'];
  physicalNodeNames.forEach((nodeId, index) => {
    // Space labels in quadrants inside the circle
    const angle = (index * Math.PI / 2) - Math.PI / 4; 
    const labelRadius = 80;
    const x = cx + labelRadius * Math.cos(angle);
    const y = cy + labelRadius * Math.sin(angle);
    
    const color = nodeColors[nodeId];
    
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    
    // Draw Text Label
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '500 10px Outfit';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Shift text slightly so it doesn't overlap circle
    ctx.fillText(`N${index + 1}`, x, y);
  });
  
  // 4. Draw Query/Prefix routing overlay if active
  if (activeRouteDebug) {
    const prefixHash = activeRouteDebug.keyHash;
    const targetNodeId = activeRouteDebug.nodeId;
    const vNodeHash = activeRouteDebug.vNodeHash;
    
    const prefixAngle = (prefixHash / 4294967295) * 2 * Math.PI - Math.PI / 2;
    const vNodeAngle = (vNodeHash / 4294967295) * 2 * Math.PI - Math.PI / 2;
    
    const px = cx + radius * Math.cos(prefixAngle);
    const py = cy + radius * Math.sin(prefixAngle);
    
    const vx = cx + radius * Math.cos(vNodeAngle);
    const vy = cy + radius * Math.sin(vNodeAngle);
    
    const nodeColor = nodeColors[targetNodeId];
    
    // Draw path from prefix hash point to virtual node point clockwise
    ctx.beginPath();
    ctx.arc(cx, cy, radius, prefixAngle, vNodeAngle);
    ctx.strokeStyle = nodeColor;
    ctx.lineWidth = 4;
    ctx.stroke();
    
    // Draw glowing prefix hash point on the ring
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#ffffff';
    ctx.fill();
    ctx.shadowBlur = 0; // reset shadow
    
    // Draw target virtual node point as slightly larger and glowing
    ctx.beginPath();
    ctx.arc(vx, vy, 6, 0, 2 * Math.PI);
    ctx.fillStyle = nodeColor;
    ctx.shadowBlur = 12;
    ctx.shadowColor = nodeColor;
    ctx.fill();
    ctx.shadowBlur = 0; // reset
    
    // Highlight the selected physical node index inside
    const physicalIdx = physicalNodeNames.indexOf(targetNodeId);
    if (physicalIdx !== -1) {
      const angle = (physicalIdx * Math.PI / 2) - Math.PI / 4; 
      const labelRadius = 80;
      const x = cx + labelRadius * Math.cos(angle);
      const y = cy + labelRadius * Math.sin(angle);
      
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, 2 * Math.PI);
      ctx.strokeStyle = nodeColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

// Animation / draw loop
function animate() {
  drawRing();
  requestAnimationFrame(animate);
}

// --- 5. INITIALIZATION ---

function init() {
  // Start metrics polling interval (every 1s)
  pollMetrics();
  setInterval(pollMetrics, 1000);
  
  // Start Canvas ring render loop
  animate();
}

// Helpers
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return num;
}

// Run initialization
init();
