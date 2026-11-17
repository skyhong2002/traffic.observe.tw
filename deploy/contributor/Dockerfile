FROM node:24.15.0-bookworm-slim
ARG SOURCE_VERSION=development
ENV NODE_ENV=production CONTRIBUTOR_VERSION=${SOURCE_VERSION}
WORKDIR /app
COPY src/similarweb.ts src/similarweb.ts
COPY tools/contributor-fetch.ts tools/contributor-agent.ts tools/
RUN mkdir /state && chown node:node /state
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18151/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "tools/contributor-agent.ts"]
