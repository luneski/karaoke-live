FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3030

ENV PORT=3030
ENV ADMIN_PASSWORD=karaoke2026
ENV DB_PATH=/app/data/karaoke.db

VOLUME ["/app/data"]

CMD ["node", "server.js"]
