FROM node:22-slim

WORKDIR /app

# Install build deps for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=optional || npm install

# Copy source
COPY . .

# Build
RUN npm run build

# Create data directory
RUN mkdir -p data

EXPOSE 9187

# Start proxy
CMD ["node", "dist/cli.js"]
