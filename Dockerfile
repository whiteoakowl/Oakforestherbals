FROM node:22.13.1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Database, session secret and uploads live on volumes so they survive redeploys.
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
CMD ["npm", "start"]
