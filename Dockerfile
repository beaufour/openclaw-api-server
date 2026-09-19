FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run check

ENV NODE_ENV=production
EXPOSE 18790

CMD ["npm", "start"]
