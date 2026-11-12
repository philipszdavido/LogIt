FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=4000 \
    LOGIT_DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY src ./src
COPY viewer ./viewer
COPY demo ./demo
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "server/index.js"]
