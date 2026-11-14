FROM ubuntu:22.04

# LANG/LC_ALL matter: ubuntu:22.04 ships no locale, so the JVM falls back to
# US-ASCII. Nitron's MainActivity.java has UTF-8 box-drawing characters in its
# comments, and scripts/prepare-template.js calls javac without -encoding,
# which fails with hundreds of "unmappable character" errors. See BUILD-FIX.md.
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

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

# Make the template compiler locale-independent. prepare-template.js builds its
# javac command without -encoding, so it inherits the platform charset. Pinning
# UTF-8 here means the build no longer depends on LANG being set correctly.
RUN cd /opt/nitron && node -e "const fs=require('fs');const f='scripts/prepare-template.js';let s=fs.readFileSync(f,'utf8');const a=\"const javacBase = ['-Xlint:-options',\";if(!s.includes(a))throw new Error('prepare-template.js: javacBase anchor not found; refusing to build with an unknown charset');if(!s.includes(\"'-encoding', 'UTF-8'\")){s=s.replace(a,\"const javacBase = ['-encoding', 'UTF-8', '-Xlint:-options',\");fs.writeFileSync(f,s);console.log('prepare-template.js: pinned javac -encoding UTF-8');}"

# Warm the Android toolchain cache and prove the stock template compiles BEFORE
# any app code is copied. This downloads android.jar (~65MB) and R8 (~16MB) into
# ~/.nitron/android in a layer that only invalidates when Nitron itself changes,
# so editing Forge Studio no longer re-downloads 82MB on every deploy.
RUN cd /opt/nitron && node scripts/prepare-template.js && \
    test -s template/base.apk && \
    test -s template/nitron-plugin-api.jar

# Verify Java and Nitron independently.
RUN echo "========== JAVA CHECK ==========" && \
    echo "JAVA_HOME=$JAVA_HOME" && \
    echo "LANG=$LANG" && \
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

# Rebuild Nitron's native Android shell with real system night-mode support.
# WebView derives prefers-color-scheme from the Activity theme's isLightTheme.
RUN test -f /app/scripts/patch-nitron-theme.js || \
    (echo "ERROR: scripts/patch-nitron-theme.js is missing from the build context. Commit it at scripts/patch-nitron-theme.js (and make sure .dockerignore does not exclude it)." && exit 1)

RUN node /app/scripts/patch-nitron-theme.js /opt/nitron/template-src/base/MainActivity.java

# Reuses the cached android.jar / R8 from the warm-up layer above.
RUN cd /opt/nitron && node scripts/prepare-template.js

# A non-empty base.apk is not proof the patch landed: assert the rebuilt DEX
# actually contains the night-theme code, so a silently skipped patch fails here
# instead of shipping an APK that ignores the system theme.
RUN test -s /opt/nitron/template/base.apk && \
    cd /opt/nitron && node -e "const z=require('adm-zip');const d=new z('template/base.apk').getEntry('classes.dex');if(!d)throw new Error('base.apk has no classes.dex');const s=d.getData().toString('latin1');for(const m of ['dark light','forgeLastNightMode','onConfigurationChanged'])if(!s.includes(m))throw new Error('night-theme patch missing from rebuilt classes.dex: '+m);console.log('OK: rebuilt classes.dex contains the Forge night-theme patch');"

EXPOSE 3000

CMD ["node", "index.js"]
