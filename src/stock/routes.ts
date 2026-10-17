// X8 create_design and X9 set_sku_status (API16): the stock functions of the owner and staff. Each is route() and a handler that reads the Idempotency-Key and hands the parsed body to its service function;
// the address and the roles come from the rows of the matrix (fn:create_design POST /v1/designs, fn:set_sku_status POST /v1/skus/status).
import type { FastifyInstance } from 'fastify';
import { registerCreateDesign } from './x08CreateDesign.js';
import { registerSetSkuStatus } from './x09SetSkuStatus.js';

export function registerStockRoutes(app: FastifyInstance): void {
  registerCreateDesign(app);
  registerSetSkuStatus(app);
}
