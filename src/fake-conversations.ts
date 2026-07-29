// ─── Fake AI Conversation Catalog ──────────────────────────────
// Rotating catalog of realistic coding user/assistant message pairs
// sent to the ads API (surface: "cli_chat") for contextual targeting.
// Privacy-preserving: never sends real user prompts.
// Matches the CLI's adMessages shape: [{role, content}].

export interface AdMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface FakeConversation {
  messages: AdMessage[]
}

// Each conversation has 2-4 message pairs (user + assistant).
// Content is realistic coding-assistant dialogue.
const CONVERSATIONS: FakeConversation[] = [
  {
    messages: [
      { role: 'user', content: '<user_message>Can you help me set up a PostgreSQL database connection in my Node.js Express app?</user_message>' },
      { role: 'assistant', content: 'I\'ll help you set up a PostgreSQL connection. Let me check your project structure first and then we can add the pg package and create a connection pool.' },
      { role: 'user', content: '<user_message>I already have pg installed. I just need the connection config.</user_message>' },
      { role: 'assistant', content: 'Great. Let me create a db.ts file with a Pool configured from environment variables and a query helper.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I have a memory leak in my React component. The useEffect cleanup is not running properly.</user_message>' },
      { role: 'assistant', content: 'Let me look at your component. The issue is likely that the cleanup function in your useEffect is not properly unsubscribing from the event listener. I can see the subscription is being created but the cleanup is missing a closure reference.' },
      { role: 'user', content: '<user_message>Can you fix it and add a test?</user_message>' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>Write a Python script that scrapes a website and saves the results to a CSV file.</user_message>' },
      { role: 'assistant', content: 'I\'ll write a Python script using requests and BeautifulSoup for scraping, then use the csv module to write results. Let me create the script with proper error handling and rate limiting.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I need to implement OAuth2 authentication with Google in my FastAPI backend.</user_message>' },
      { role: 'assistant', content: 'I\'ll set up Google OAuth2 using the authlib library with FastAPI. We need to configure the OAuth client, add the callback endpoint, and handle token storage. Let me check your existing auth setup first.' },
      { role: 'user', content: '<user_message>Make sure to include refresh token handling too.</user_message>' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>My Docker container keeps exiting with code 137. Any ideas?</user_message>' },
      { role: 'assistant', content: 'Exit code 137 means the container was killed by the OOM killer. Your container is running out of memory. Let me check your Docker Compose memory limits and the application\'s memory usage.' },
      { role: 'user', content: '<user_message>How do I increase the memory limit?</user_message>' },
      { role: 'assistant', content: 'In your docker-compose.yml, add mem_limit under the service. I\'d also recommend profiling the app to find the actual leak.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>Refactor this TypeScript function to use async/await instead of callbacks.</user_message>' },
      { role: 'assistant', content: 'I\'ll convert the callback-based function to use async/await. The main changes are wrapping it in an async function, replacing the callback with try/catch, and using await for the async operations.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I need to add unit tests for my Go HTTP handler. How should I structure them?</user_message>' },
      { role: 'assistant', content: 'For Go HTTP handlers, I recommend using httptest.NewRecorder to test without starting a real server. Let me create test cases that cover success, not found, and error paths using table-driven tests.' },
      { role: 'user', content: '<user_message>Can you also add a test for the middleware?</user_message>' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>How do I configure Nginx as a reverse proxy for my Node.js app with WebSocket support?</user_message>' },
      { role: 'assistant', content: 'I\'ll create an Nginx config with proxy_pass for your Node.js app, plus the Upgrade and Connection headers needed for WebSocket support. I\'ll also include SSL configuration and rate limiting.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I\'m getting a CORS error when trying to fetch from my frontend. The backend is on a different port.</user_message>' },
      { role: 'assistant', content: 'The CORS error happens because your frontend and backend are on different origins. You need to add the Access-Control-Allow-Origin header in your backend. Let me check your Express middleware setup.' },
      { role: 'user', content: '<user_message>I tried adding cors package but it\'s still not working.</user_message>' },
      { role: 'assistant', content: 'The issue might be that you\'re setting the header after sending the response, or the OPTIONS preflight request isn\'t being handled. Let me look at your middleware order.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>Write a SQL query to find the top 10 customers by total order amount in the last 30 days.</user_message>' },
      { role: 'assistant', content: 'Here\'s the query using a JOIN between customers and orders, filtered by order date, grouped by customer, and ordered by total amount descending with a LIMIT 10.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>Help me set up CI/CD with GitHub Actions for my Python project. I need linting, testing, and deployment.</user_message>' },
      { role: 'assistant', content: 'I\'ll create a GitHub Actions workflow that runs on push to main. It will set up Python, install dependencies, run ruff for linting, pytest for testing, and deploy to your server on success.' },
      { role: 'user', content: '<user_message>Add a step to build and push a Docker image too.</user_message>' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I want to implement rate limiting in my Express API. What\'s the best approach?</user_message>' },
      { role: 'assistant', content: 'For Express rate limiting, I recommend using express-rate-limit middleware. It\'s simple to configure and supports both global and per-route limits. For distributed systems, you can use a Redis store.' },
      { role: 'user', content: '<user_message>Can you show me how to set it up with Redis?</user_message>' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>My Jest tests are slow. How can I speed them up?</user_message>' },
      { role: 'assistant', content: 'There are several ways to speed up Jest tests: running tests in parallel, using shallow rendering, mocking heavy dependencies, and configuring testEnvironment properly. Let me analyze your test suite first.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I need to implement a Redis cache layer for my API responses. The data changes infrequently.</user_message>' },
      { role: 'assistant', content: 'I\'ll create a caching middleware that checks Redis before hitting your database. We\'ll use a TTL-based strategy since your data changes infrequently, and add a cache invalidation function for when data does change.' },
      { role: 'user', content: '<user_message>What TTL should I use?</user_message>' },
      { role: 'assistant', content: 'Since the data changes infrequently, a TTL of 5-15 minutes is reasonable. You can also use a stale-while-revalidate pattern for even better performance.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>Can you help me debug this TypeScript generic type error? I\'m getting a type mismatch.</user_message>' },
      { role: 'assistant', content: 'The type error is because TypeScript is inferring the generic parameter too narrowly. You need to add a type constraint to your generic or use a wider type. Let me see the exact code.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I want to migrate my REST API to GraphQL. Where should I start?</user_message>' },
      { role: 'assistant', content: 'Migrating from REST to GraphQL is a good choice for reducing over-fetching. Start by defining your schema types, then create resolvers that map to your existing data sources. You can run both in parallel during the transition.' },
      { role: 'user', content: '<user_message>Should I use Apollo Server or graphql-yoga?</user_message>' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>My Kubernetes pod keeps crashing. The logs show an OOMKilled status.</user_message>' },
      { role: 'assistant', content: 'OOMKilled means your container exceeded its memory limit. You need to either increase the resource limits in your deployment manifest or optimize your application\'s memory usage. Let me check your resource requests and limits.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>How do I implement pagination in my MongoDB query using cursor-based pagination?</user_message>' },
      { role: 'assistant', content: 'Cursor-based pagination in MongoDB uses the _id field as a cursor. You query for documents with _id greater than the last seen ID, sorted ascending, and limited to your page size. This is more efficient than skip/limit for large collections.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>I need to set up end-to-end testing with Playwright for my Next.js app.</user_message>' },
      { role: 'assistant', content: 'I\'ll set up Playwright with a config file, test fixtures, and a few example tests covering login, navigation, and form submission. I\'ll also add it to your CI pipeline.' },
      { role: 'user', content: '<user_message>Can you add visual regression testing too?</user_message>' },
      { role: 'assistant', content: 'Sure, I\'ll add Playwright\'s screenshot comparison feature to detect visual regressions automatically.' },
    ],
  },
  {
    messages: [
      { role: 'user', content: '<user_message>Write a Rust function that reads a file, parses JSON, and returns a typed struct.</user_message>' },
      { role: 'assistant', content: 'I\'ll use serde for JSON deserialization. The function will read the file with std::fs, parse with serde_json, and return a Result with your typed struct. I\'ll also add proper error handling with anyhow.' },
    ],
  },
]

// ─── Rotation ───────────────────────────────────────────────────

let rotationIndex = 0

export function getFakeConversation(): FakeConversation {
  const convo = CONVERSATIONS[rotationIndex % CONVERSATIONS.length]
  rotationIndex++
  return convo
}
