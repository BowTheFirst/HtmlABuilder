
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
        git \
        unzip \
        zip && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 20.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Build Nitron from a pinned plugin-capable source revision.
# Native plugins were added in 3.2.0; npm still publishes 3.1.5, which
# silently ignores the plugin configuration and produces APKs without DEX.
ARG NITRON_COMMIT=d20713023d84880ab9b26f44e0e57f919917cb6c
RUN git clone https://github.com/ALightbolt4G/nitron.git /opt/nitron && \
    cd /opt/nitron && \
    git checkout --detach "${NITRON_COMMIT}" && \
    test "$(node -p "require('./package.json').version")" = "3.2.0" && \
    test -s template/base.apk && \
    test -s template/nitron-plugin-api.jar

# Keep dependency installation and CLI compilation in separate layers so a
# failed command is visible in the Docker build output.
RUN cd /opt/nitron && npm ci --include=dev --no-audit --no-fund

RUN cd /opt/nitron && \
    npm run build && \
    npm link && \
    test "$(nitron --version)" = "3.2.0"

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
