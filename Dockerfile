FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
