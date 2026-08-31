FROM node:22-slim

# better-sqlite3 precisa compilar um binário nativo
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Onde o banco SQLite fica salvo — monte um volume aqui em produção
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "src/server.js"]
