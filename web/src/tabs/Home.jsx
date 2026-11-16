import { useState } from 'react';
import { apiRequest } from '../api.js';
import { errorText, formatPaise } from '../lib.js';
import { PaymentForm } from '../PaymentForm.jsx';

const toPaise = (text) => (/^\d+(\.\d{1,2})?$/.test(text?.trim() ?? '') ? Math.round(Number(text) * 100) : 0);

export function Home({ me, onPaid, goTo }) {
  const { settings, user } = me;
  const needsOtp = (values) => user.twoFactorEnabled && toPaise(values.amount) >= settings.stepUpThresholdPaise;

  return (
    <div className="grid">
      <div className="stack">
        {settings.razorpay && <RazorpayTopUp keyId={settings.razorpay.keyId} max={settings.maxTopupPaise} onDone={onPaid} />}
        {settings.simulatedTopups && (
          <PaymentForm
            title={settings.razorpay ? 'Add money (demo)' : 'Add money'}
            subtitle={`Simulated payment gateway · max ${formatPaise(settings.maxTopupPaise)}`}
            submitLabel="Add money"
            fields={[{ name: 'amount', label: 'Amount (₹)', inputMode: 'decimal', placeholder: '500.00' }]}
            path="/wallet/topups"
            success={(data) => `Added ${formatPaise(data.transaction.amountPaise)}.`}
            onDone={onPaid}
          />
        )}
      </div>
      <PaymentForm
        title="Send money"
        subtitle={`To any PayLedger user by email · max ${formatPaise(settings.maxTransferPaise)} · ${formatPaise(settings.stepUpThresholdPaise)}+ needs 2-step verification`}
        submitLabel="Send"
        fields={[
          { name: 'toEmail', label: 'Recipient email', type: 'email', placeholder: 'friend@example.com' },
          { name: 'amount', label: 'Amount (₹)', inputMode: 'decimal', placeholder: '250.00' },
          { name: 'note', label: 'Note (optional)', optional: true, placeholder: 'Dinner', maxLength: 140 },
        ]}
        path="/transfers"
        needsOtp={needsOtp}
        onNeedTwoFactor={() => goTo('security')}
        success={(data) => `Sent ${formatPaise(data.transaction.amountPaise)} to ${data.transaction.to.name}.`}
        onDone={onPaid}
      />
    </div>
  );
}

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: 'https://checkout.razorpay.com/v1/checkout.js', onload: resolve, onerror: reject });
    document.body.append(script);
  });
}

/** Card / UPI / netbanking top-up through Razorpay Checkout (test mode with test keys). */
function RazorpayTopUp({ keyId, max, onDone }) {
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState({ kind: 'idle' });

  const pay = async (event) => {
    event.preventDefault();
    setStatus({ kind: 'busy' });
    try {
      await loadCheckout();
      const { data: order } = await apiRequest('/wallet/topups/orders', { method: 'POST', body: { amount } });
      const checkout = new window.Razorpay({
        key: keyId,
        order_id: order.orderId,
        amount: order.amountPaise,
        currency: 'INR',
        name: 'PayLedger',
        description: 'Add money to wallet',
        handler: async (result) => {
          // Razorpay signed this result; the server checks the signature before crediting.
          // If this request is lost, the webhook still credits the wallet (exactly once).
          try {
            const { data } = await apiRequest(`/wallet/topups/orders/${order.orderId}/confirm`, {
              method: 'POST',
              body: { razorpayPaymentId: result.razorpay_payment_id, razorpaySignature: result.razorpay_signature },
            });
            setStatus({ kind: 'ok', message: `Added ${formatPaise(order.amountPaise)}. Balance ${formatPaise(data.balancePaise)}.` });
            setAmount('');
            onDone();
          } catch (err) {
            setStatus({ kind: 'error', message: `${errorText(err)} If money left your account, it will be credited automatically.` });
          }
        },
        modal: { ondismiss: () => setStatus({ kind: 'idle' }) },
      });
      checkout.on('payment.failed', (response) => setStatus({ kind: 'error', message: response.error?.description ?? 'Payment failed.' }));
      checkout.open();
    } catch (err) {
      setStatus({ kind: 'error', message: errorText(err) });
    }
  };

  return (
    <form className="card" onSubmit={pay}>
      <h2>Add money with card or UPI</h2>
      <p className="muted">Razorpay · max {formatPaise(max)}</p>
      <label>
        Amount (₹)
        <input required inputMode="decimal" placeholder="500.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      {status.kind === 'ok' && <p className="form-ok">{status.message}</p>}
      {status.kind === 'error' && <p className="form-error">{status.message}</p>}
      <button className="btn primary wide" disabled={status.kind === 'busy'}>
        {status.kind === 'busy' ? 'Opening Razorpay…' : 'Pay with Razorpay'}
      </button>
    </form>
  );
}
