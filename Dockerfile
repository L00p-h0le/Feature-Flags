FROM node:24.18.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json .npmrc ./
COPY packages/evaluator/package.json packages/evaluator/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm ci --include=dev --ignore-scripts
COPY packages/evaluator/src packages/evaluator/src
COPY packages/evaluator/tsconfig.build.json packages/evaluator/tsconfig.build.json
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.build.json apps/api/tsconfig.build.json
COPY apps/api/migrations apps/api/migrations
COPY apps/dashboard/src apps/dashboard/src
COPY apps/dashboard/public apps/dashboard/public
COPY apps/dashboard/index.html apps/dashboard/vite.config.ts apps/dashboard/tsconfig.json apps/dashboard/
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.18.1-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/packages/evaluator/package.json ./packages/evaluator/package.json
COPY --chown=node:node --from=build /app/packages/evaluator/dist ./packages/evaluator/dist
COPY --chown=node:node --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --chown=node:node --from=build /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --chown=node:node --from=build /app/apps/dashboard/package.json ./apps/dashboard/package.json
COPY --chown=node:node --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]
