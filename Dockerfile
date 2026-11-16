FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server/ ./server/
COPY --from=web /app/web/dist ./web/dist
USER node
EXPOSE 4000
# `exec` replaces the shell with node, so node receives SIGTERM directly and shuts down gracefully.
CMD ["sh", "-c", "node server/scripts/migrate.js && exec node server/src/server.js"]
