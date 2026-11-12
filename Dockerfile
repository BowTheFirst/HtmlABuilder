FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y openjdk-17-jdk-headless curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Nitron globally
RUN npm install -g nitron --no-audit --no-fund

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY . .

CMD ["node", "index.js"]