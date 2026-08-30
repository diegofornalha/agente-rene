'use strict';
// app.js — montagem do Express + HTTP server + Socket.IO + middlewares base
// (CORS, JSON condicional, static, multer). Separado do server.js (boot +
// listen) pra permitir testes com supertest sem subir porta.

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = (process.env.SOCKET_IO_CORS_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());

const io = socketIo(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: ALLOWED_ORIGINS }));
// Parser JSON global (100KB default). Pula o /v1/* — lá o openai-compat usa o
// próprio parser de 25MB (o system prompt + tools do hermes passa de 100KB e
// senão levaria 413 aqui antes de chegar na rota).
const _globalJson = express.json();
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) return next();
  return _globalJson(req, res, next);
});

app.use('/dashboards', express.static(path.join(__dirname, 'src', 'dashboards')));

// Storage for uploaded files
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads';
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow text files and common code files
    const allowedTypes = [
      'text/plain',
      'text/javascript',
      'text/html',
      'text/css',
      'application/json',
      'application/javascript'
    ];

    const allowedExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
      '.css', '.html', '.json', '.xml', '.yaml', '.yml', '.md', '.txt',
      '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.sql'
    ];

    const ext = path.extname(file.originalname).toLowerCase();
    const isAllowedType = allowedTypes.includes(file.mimetype);
    const isAllowedExt = allowedExtensions.includes(ext);

    if (isAllowedType || isAllowedExt || file.mimetype.startsWith('text/')) {
      cb(null, true);
    } else {
      cb(new Error('Only text and code files are allowed'), false);
    }
  }
});

module.exports = { app, server, io, upload, ALLOWED_ORIGINS };
