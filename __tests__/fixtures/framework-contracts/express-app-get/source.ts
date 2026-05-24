import express from 'express';
import { listUsers } from './handlers';

const app = express();
app.get('/users', listUsers);

export default app;
