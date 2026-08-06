FROM node:22-slim

WORKDIR /app

# Build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN mkdir -p data
EXPOSE 9187

CMD ["node", "dist/cli.js"]
