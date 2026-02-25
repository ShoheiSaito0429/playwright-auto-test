FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p data/recordings data/testcases data/screenshots

EXPOSE 3200

CMD ["node", "--import", "tsx/esm", "src/server/index.ts"]
