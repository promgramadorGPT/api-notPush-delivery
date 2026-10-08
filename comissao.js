'use strict';
// V2.5 — Comissão da plataforma e validação de reembolso (funções puras, sem Firebase/MP).
// A % vem do painel Master (config_plataforma/comissao/percentual) e incide sobre os PRODUTOS do pedido, antes de descontos e sem a entrega.

const arred = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PERCENTUAL_MAX = 50;

function percentualValido(p) {
  const n = Number(p);
  return Number.isFinite(n) && n >= 0 && n <= PERCENTUAL_MAX ? arred(n) : null;
}

// V2.7 — Base = valor dos PRODUTOS antes de qualquer desconto, sem a entrega.
// Cupom e presente são custo da loja: a comissão da plataforma não diminui por causa deles.
function baseComissao(pedido) {
  const itens = Array.isArray(pedido?.itens) ? pedido.itens : [];
  const somaItens = itens.reduce((s, i) => s + (Number(i.precio) || 0) * (Number(i.qtd) || 0), 0);
  const sub = Number(pedido?.subtotal);
  const subtotal = Number.isFinite(sub) && sub >= 0 ? sub : somaItens;
  return arred(Math.max(0, subtotal));
}

function calcularComissao(pedido, percentual) {
  const p = percentualValido(percentual) ?? 0;
  const base = baseComissao(pedido);
  let valor = arred((base * p) / 100);
  const total = Number(pedido?.total) || 0;
  // O Mercado Pago exige que a taxa seja menor que o valor cobrado.
  if (valor >= total) valor = Math.max(0, arred(total - 0.01));
  return { percentual: p, base, valor };
}

// Pode executar a devolução pelo Mercado Pago? (a decisão de aprovar é da loja, no painel)
function validarReembolso(pedido) {
  const r = pedido?.reembolso;
  if (!r) return { ok: false, status: 409, erro: 'Este pedido não tem reembolso registrado.' };
  if (r.status !== 'aprovado') return { ok: false, status: 409, erro: 'O reembolso ainda não foi aprovado.' };
  const ex = r.execucao?.status;
  if (ex === 'concluido') return { ok: false, status: 409, erro: 'Este reembolso já foi devolvido.' };
  if (ex === 'processando') return { ok: false, status: 409, erro: 'A devolução deste reembolso já está em andamento.' };
  if (!pedido.paymentIdMP) return { ok: false, status: 409, erro: 'Este pedido não foi pago online pelo Mercado Pago.' };
  const pago = String(pedido.paymentStatusMP || '').toLowerCase() === 'approved' || pedido.pagoStatus === 'Aprobado';
  if (!pago) return { ok: false, status: 409, erro: 'O pagamento deste pedido não está aprovado.' };
  if (r.origem === 'cliente' && pedido.entregaConfirmada === true) {
    return { ok: false, status: 409, erro: 'Pedido com entrega confirmada: a devolução pelo aplicativo não é permitida.' };
  }
  const total = arred(pedido.total);
  const valor = arred(r.valor);
  if (!(valor > 0)) return { ok: false, status: 400, erro: 'Valor do reembolso inválido.' };
  if (valor > total + 0.011) return { ok: false, status: 400, erro: 'O valor do reembolso não pode ser maior que o total do pedido.' };
  return { ok: true, valor: Math.min(valor, total), paymentId: String(pedido.paymentIdMP) };
}

module.exports = { arred, PERCENTUAL_MAX, percentualValido, baseComissao, calcularComissao, validarReembolso };
