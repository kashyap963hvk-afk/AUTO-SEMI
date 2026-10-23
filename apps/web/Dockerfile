FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN NEXT_TELEMETRY_DISABLED=1 npm run build
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000
CMD ["npm", "start"]
