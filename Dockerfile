
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

# Install Java 17 JDK and system utilities.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openjdk-17-jdk-headless \
        curl \
        ca-certificates \
        unzip \
        zip && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 20.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Nitron 3.1.5.
RUN npm install -g nitron@3.1.5 --no-audit --no-fund

# Verify Java and Nitron independently.
RUN echo "========== JAVA CHECK ==========" && \
    echo "JAVA_HOME=$JAVA_HOME" && \
    command -v java || true

RUN echo "========== JAVAC CHECK ==========" && \
    command -v javac || true

RUN echo "========== NITRON CHECK ==========" && \
    command -v nitron || true

RUN echo "========== INSTALLED VERSIONS ==========" && \
    java -version && \
    javac -version && \
    npm --version && \
    node --version

# Verify Nitron's installation location.
RUN echo "========== NITRON GLOBAL PACKAGES ==========" && \
    npm list -g --depth=0 && \
    npm root -g

# Set up Forge Studio.
WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
