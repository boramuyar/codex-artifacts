FROM node:24-alpine

WORKDIR /opt/dc-canvas
COPY package.json GUIDE.md ./
COPY bin/ bin/
COPY src/ src/
COPY ui/ ui/

RUN chmod 755 bin/dc-canvas.mjs \
    && ln -s /opt/dc-canvas/bin/dc-canvas.mjs /usr/local/bin/dc-canvas \
    && mkdir -p /workspace/library \
    && chown node:node /workspace /workspace/library

USER node
WORKDIR /workspace
EXPOSE 4173
ENTRYPOINT ["dc-canvas"]
CMD ["serve", "--library", "/workspace/library", "--host", "0.0.0.0"]
