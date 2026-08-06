FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=optional

COPY . .
RUN npm run build

RUN mkdir -p data

EXPOSE 9187

CMD ["node", "dist/cli.js"]
