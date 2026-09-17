# Parallax — production container.
# Multi-stage: build with full deps, then run. Persist the datastore by mounting
# a volume at /app/.data (users, sessions, shared workspaces live there).

FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8788
COPY --from=build /app ./
EXPOSE 8788
VOLUME ["/app/.data"]
CMD ["npm", "start"]
