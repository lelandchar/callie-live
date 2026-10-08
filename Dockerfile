# Callie Live Assistant web service: the Node server, the static app and the Arize fact base.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production CALLIE_HOSTED=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
