# ==============================================================================
# Coinbase Crypto Bot - Multi-Arch Container Image
# Works on x86_64, ARM64 (Raspberry Pi 3/4/5), ARMv7 (Raspberry Pi 2)
# ==============================================================================

FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies if needed
RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# Production runtime stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=29600
ENV HOST=0.0.0.0
ENV FQDN=localhost
ENV BASE_PATH=/

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY templates/ ./templates/

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 29600

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
