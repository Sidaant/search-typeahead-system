FROM node:22-alpine

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY server/ ./server/
COPY public/ ./public/
COPY data/ ./data/

EXPOSE 3000

# Start server
CMD ["node", "server/server.js"]
