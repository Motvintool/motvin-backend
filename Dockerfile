# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./

# Install dependencies
RUN npm install

# Copy source
COPY src/ ./src/

# Build
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm install --production && npm cache clean --force

# Copy built app from builder
COPY --from=builder /app/dist ./dist

# Create data directory (will be mounted as volume)
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run app
CMD ["node", "dist/main.js"]
