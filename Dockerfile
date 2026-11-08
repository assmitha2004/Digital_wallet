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
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist
EXPOSE 4000
CMD ["sh", "-c", "node server/scripts/migrate.js && node server/src/server.js"]
