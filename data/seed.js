import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vocabularies for query generation
const prefixes = [
  'how to', 'best', 'cheap', 'near me', 'what is', 'tutorial', 'flights to', 'buy', 'learn', 
  'free', 'download', 'online', 'easy', 'simple', 'latest', 'top 10', 'review', 'guide to', 
  'where to find', 'why does', 'difference between', 'how much is', 'is it safe to', 
  'get started with', 'advanced', 'complete', 'introduction to', 'compare', 'price of', 
  'alternative to', 'history of', 'symptoms of', 'benefits of', 'course on', 'job in', 
  'salary of', 'career in', 'future of', 'problems with', 'solutions for'
];

const modifiers = [
  'modern', 'vintage', 'wireless', 'electric', 'organic', 'healthy', 'quick', 'delicious', 
  'professional', 'beginner', 'developer', 'gaming', 'portable', 'outdoor', 'indoor', 
  'smart', 'digital', 'local', 'global', 'remote', 'hybrid', 'custom', 'luxury', 'budget', 
  'premium', 'minimalist', 'automated', 'interactive', 'responsive', 'secure', 'fast', 
  'cloud', 'native', 'open source', 'corporate', 'creative', 'daily', 'weekly', 'monthly'
];

const subjects = [
  'javascript', 'python', 'react', 'nodejs', 'css', 'html', 'sql', 'aws', 'docker', 'rust', 
  'c plus plus', 'java', 'c sharp', 'machine learning', 'ai', 'chatgpt', 'deep learning', 
  'database', 'system design', 'microservices', 'rest api', 'graphql', 'iphone', 'samsung', 
  'macbook', 'ipad', 'dell laptop', 'headphones', 'nintendo switch', 'playstation', 'xbox', 
  'running shoes', 'pizza', 'chocolate cake', 'chicken pasta', 'breakfast', 'paris flight', 
  'london hotel', 'tokyo travel', 'new york subway', 'rome history', 'barcelona weather', 
  'stock trading', 'crypto currency', 'bitcoin wallet', 'git hub', 'youtube video', 
  'netflix show', 'spotify playlist', 'amazon prime', 'google doc', 'canva design', 
  'figma UI', 'vs code editor', 'kubernetes cluster', 'terraform script', 'home workout', 
  'yoga class', 'coffee maker', 'air fryer', 'robotic vacuum', 'mechanical keyboard', 
  'ergonomic chair', 'standing desk', 'monitor mount', 'backpack', 'sunglasses', 'water bottle'
];

const suffixes = [
  'for beginners', 'in 2026', 'on a budget', 'with examples', 'step by step', 'explained', 
  'for study', 'for work', 'near my location', 'without coding', 'using python', 
  'using react', 'with source code', 'in 10 minutes', 'for students', 'for kids', 
  'for adults', 'for seniors', 'at home', 'in the office', 'in english', 'pdf download', 
  'cheat sheet', 'best practices', 'tips and tricks', 'common mistakes', 'interview questions', 
  'comparison chart', 'specifications', 'deals', 'promo code', 'coupons', 'free trial'
];

function generateUniqueQueries(targetCount) {
  const uniqueQueries = new Set();
  
  // Hand-add some very high frequency short terms to represent head queries
  const headQueries = [
    'iphone', 'weather', 'google', 'youtube', 'facebook', 'amazon', 'netflix', 'chatgpt', 
    'gmail', 'translate', 'maps', 'reddit', 'github', 'spotify', 'wikipedia', 'news', 
    'wordle', 'calculator', 'javascript', 'python', 'zoom', 'canva', 'figma', 'airbnb', 
    'roblox', 'twitter', 'linkedin', 'instagram', 'pinterest', 'flights', 'hotels', 'walmart', 
    'target', 'ebay', 'best buy', 'costco', 'weather tomorrow', 'stocks', 'bitcoin', 'nfl'
  ];
  headQueries.forEach(q => uniqueQueries.add(q));

  // Generate combinations until we hit the target size
  let iterations = 0;
  const maxIterations = targetCount * 20; // prevent infinite loops
  
  while (uniqueQueries.size < targetCount && iterations < maxIterations) {
    iterations++;
    const parts = [];
    
    // Choose pattern
    const pattern = Math.floor(Math.random() * 5);
    
    if (pattern === 0) {
      // prefix + subject
      parts.push(prefixes[Math.floor(Math.random() * prefixes.length)]);
      parts.push(subjects[Math.floor(Math.random() * subjects.length)]);
    } else if (pattern === 1) {
      // modifier + subject
      parts.push(modifiers[Math.floor(Math.random() * modifiers.length)]);
      parts.push(subjects[Math.floor(Math.random() * subjects.length)]);
    } else if (pattern === 2) {
      // subject + suffix
      parts.push(subjects[Math.floor(Math.random() * subjects.length)]);
      parts.push(suffixes[Math.floor(Math.random() * suffixes.length)]);
    } else if (pattern === 3) {
      // prefix + modifier + subject
      parts.push(prefixes[Math.floor(Math.random() * prefixes.length)]);
      parts.push(modifiers[Math.floor(Math.random() * modifiers.length)]);
      parts.push(subjects[Math.floor(Math.random() * subjects.length)]);
    } else {
      // prefix + subject + suffix
      parts.push(prefixes[Math.floor(Math.random() * prefixes.length)]);
      parts.push(subjects[Math.floor(Math.random() * subjects.length)]);
      parts.push(suffixes[Math.floor(Math.random() * suffixes.length)]);
    }

    const query = parts.join(' ').toLowerCase().trim();
    // Exclude queries with commas to avoid complex CSV issues
    if (query && !query.includes(',')) {
      uniqueQueries.add(query);
    }
  }

  return Array.from(uniqueQueries);
}

function run() {
  const targetCount = 105000;
  console.log(`Generating ${targetCount} unique search queries...`);
  
  const queryList = generateUniqueQueries(targetCount);
  console.log(`Successfully generated ${queryList.length} unique queries.`);
  
  // Sort queries to distribute counts. We will shuffle them slightly, but keep high-popularity items 
  // at the top of the array so we can apply Zipf's Law.
  // We'll leave the head queries at the front, and shuffle the rest.
  const headSize = 100;
  const headPart = queryList.slice(0, headSize);
  const tailPart = queryList.slice(headSize);
  
  // Simple shuffle for the tail
  for (let i = tailPart.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tailPart[i], tailPart[j]] = [tailPart[j], tailPart[i]];
  }
  
  const orderedList = [...headPart, ...tailPart];
  
  // Apply Zipf's Law: count = base / (rank + 1)^s
  const baseCount = 5000000; // max count for rank 0
  const s = 0.92; // decay exponent
  
  console.log('Calculating Zipfian counts...');
  const csvLines = ['query,count'];
  
  for (let i = 0; i < orderedList.length; i++) {
    const rank = i + 1;
    const count = Math.max(1, Math.floor(baseCount / Math.pow(rank, s)));
    csvLines.push(`${orderedList[i]},${count}`);
  }
  
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const csvPath = path.join(dataDir, 'queries.csv');
  console.log(`Writing dataset to ${csvPath}...`);
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
  
  console.log('Dataset generation completed successfully!');
  console.log(`File size: ${(fs.statSync(csvPath).size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Top query: "${orderedList[0]}" with count ${Math.floor(baseCount / Math.pow(1, s))}`);
  console.log(`100,000th query: "${orderedList[99999]}" with count ${Math.floor(baseCount / Math.pow(100000, s))}`);
}

run();
