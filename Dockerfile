FROM node:22-slim

RUN apt-get update && \
    apt-get install -y sqlite3 make python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY package.json yarn.lock ./
RUN echo 'nodeLinker: node-modules' > .yarnrc.yml && \
    yarn install

COPY tsconfig.json Makefile style.css help.html ./
COPY src src/

CMD ["make", "all", "publish"]
