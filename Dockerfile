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

CMD ["node", "index.js"]Y package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Start the server
CMD ["node", "index.js"]d $ANDROID_HOME/cmdline-tools && \
    mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && \
    rm sdk.zip && \
    yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses && \
    $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-33" "build-tools;33.0.1"

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# THIS IS THE UPDATED LINE:
CMD ["node", "index.js"]e-tools/latest/bin/sdkmanager --licenses && \
    $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-33" "build-tools;33.0.1"

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Start the server
CMD ["node", "server.js"]