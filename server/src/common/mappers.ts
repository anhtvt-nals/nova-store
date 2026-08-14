type Row = Record<string, any>;

export function mapOrder(row: Row) {
  const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
  const resource = Array.isArray(row.resources) ? row.resources[0] : row.resources;
  const directProduct = Array.isArray(row.products) ? row.products[0] : row.products;
  const product = directProduct || (Array.isArray(plan?.products) ? plan.products[0] : plan?.products);
  return {
    id: row.id,
    planName: row.plan_name_snapshot || plan?.name || 'Unknown plan',
    nodeName: row.resource_name_snapshot || resource?.name || 'Unassigned',
    productName: product?.name || 'Service',
    productCode: product?.code || 'service',
    serviceType: product?.service_type || 'service',
    amount: Number(row.amount),
    status: row.status,
    paymentMethod: row.payment_method,
    orderGroupId: row.order_group_id,
    unitPrice: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
    nodeCount: Number(row.node_count || 1),
    rentalDays: Number(row.rental_days || 1),
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
  };
}

export function mapPlan(row: Row) {
  const product = Array.isArray(row.products) ? row.products[0] : row.products;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    durationHours: row.duration_hours,
    nodeCount: Number(row.config?.nodeCount || 1),
    rotation: `${row.rotation_minutes} min`,
    highlighted: row.highlighted,
    productId: row.product_id,
    productCode: product?.code || 'service',
    productName: product?.name || 'Service',
    serviceType: product?.service_type || 'service',
    productDescription: product?.description || '',
    unitPrice: Number(product?.base_price || 0),
    currency: product?.currency || 'USD',
  };
}

export function mapResource(row: Row) {
  return {
    id: row.id,
    name: row.name,
    city: row.region?.city || '',
    country: row.region?.country || '',
    status: row.status,
    protocol: row.capabilities?.protocol || 'SOCKS5',
    latencyMs: Number(row.health?.latencyMs || 0),
    productId: row.product_id,
  };
}
