FROM node:20-alpine AS deps
WORKDIR /app
COPY . .
RUN npm install

FROM deps AS build
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/services ./services
COPY --from=build /app/agents ./agents
COPY --from=build /app/simulation ./simulation
COPY --from=build /app/packages ./packages
COPY --from=build /app/contracts ./contracts
CMD ["node", "services/matching-engine/dist/index.js"]
