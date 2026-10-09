'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SAMPLES_PER_AXIS = 4;
const BACKGROUND = Object.freeze([0xf0, 0x51, 0x33]);
const FOREGROUND = Object.freeze([0xff, 0xff, 0xff]);
const CORNER_RADIUS = 26;
const STROKE_HALF_WIDTH = 4;
const NODE_RADIUS = 11;
const NODES = Object.freeze([[42, 30], [42, 98], [88, 44]]);
const TRUNK = Object.freeze([[42, 41], [42, 87]]);
const BRANCH_CURVE = Object.freeze([[88, 55], [88, 78], [42, 66], [42, 86]]);
const CURVE_SEGMENTS = 64;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function flattenCubic(controlPoints) {
    const points = [];
    for (let index = 0; index <= CURVE_SEGMENTS; index += 1) {
        const t = index / CURVE_SEGMENTS;
        const u = 1 - t;
        const weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        let x = 0;
        let y = 0;
        for (let i = 0; i < weights.length; i += 1) {
            x += weights[i] * controlPoints[i][0];
            y += weights[i] * controlPoints[i][1];
        }
        points.push([x, y]);
    }
    return points;
}

function isInsideRoundedSquare(x, y) {
    const cornerX = Math.min(Math.max(x, CORNER_RADIUS), SIZE - CORNER_RADIUS);
    const cornerY = Math.min(Math.max(y, CORNER_RADIUS), SIZE - CORNER_RADIUS);
    return Math.hypot(x - cornerX, y - cornerY) <= CORNER_RADIUS;
}

function colorAt(x, y, curve) {
    if (!isInsideRoundedSquare(x, y)) {
        return undefined;
    }
    for (const center of NODES) {
        const distance = Math.hypot(x - center[0], y - center[1]);
        if (Math.abs(distance - NODE_RADIUS) <= STROKE_HALF_WIDTH) {
            return FOREGROUND;
        }
        if (distance < NODE_RADIUS) {
            return BACKGROUND;
        }
    }
    const point = [x, y];
    if (distanceToSegment(point, TRUNK[0], TRUNK[1]) <= STROKE_HALF_WIDTH) {
        return FOREGROUND;
    }
    for (let index = 1; index < curve.length; index += 1) {
        if (distanceToSegment(point, curve[index - 1], curve[index]) <= STROKE_HALF_WIDTH) {
            return FOREGROUND;
        }
    }
    return BACKGROUND;
}

function renderPixels() {
    const curve = flattenCubic(BRANCH_CURVE);
    const rows = [];
    for (let y = 0; y < SIZE; y += 1) {
        const row = Buffer.alloc(1 + SIZE * 4);
        for (let x = 0; x < SIZE; x += 1) {
            const sum = [0, 0, 0, 0];
            for (let sy = 0; sy < SAMPLES_PER_AXIS; sy += 1) {
                for (let sx = 0; sx < SAMPLES_PER_AXIS; sx += 1) {
                    const color = colorAt(x + (sx + 0.5) / SAMPLES_PER_AXIS, y + (sy + 0.5) / SAMPLES_PER_AXIS, curve);
                    if (color === undefined) {
                        continue;
                    }
                    sum[0] += color[0];
                    sum[1] += color[1];
                    sum[2] += color[2];
                    sum[3] += 1;
                }
            }
            const offset = 1 + x * 4;
            if (sum[3] > 0) {
                row[offset] = Math.round(sum[0] / sum[3]);
                row[offset + 1] = Math.round(sum[1] / sum[3]);
                row[offset + 2] = Math.round(sum[2] / sum[3]);
                row[offset + 3] = Math.round((sum[3] / (SAMPLES_PER_AXIS * SAMPLES_PER_AXIS)) * 255);
            }
        }
        rows.push(row);
    }
    return Buffer.concat(rows);
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePng(pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(SIZE, 0);
    header.writeUInt32BE(SIZE, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const target = path.join(__dirname, '..', 'images', 'icon.png');
fs.writeFileSync(target, encodePng(renderPixels()));
console.log(`Written ${target}`);
