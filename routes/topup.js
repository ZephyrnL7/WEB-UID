const router = require('express').Router()
const pool = require('../db')
const { auth } = require('./middleware')
const Stripe = require('stripe')
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null

function stripeEnabled(res) {
  if (!stripe) {
    console.error('Missing STRIPE_SECRET_KEY environment variable')
    res.status(500).json({ success: false, error: 'Payment configuration missing' })
    return false
  }
  return true
}

const TOPUP_AMOUNTS = [5, 10, 20, 50]

function formatMoney(value) {
  return Number(value).toFixed(2)
}

router.get('/options', async (req, res) => {
  try {
    const options = TOPUP_AMOUNTS.map(amount => {
      const fee = Number((amount * 0.02).toFixed(2))
      const total = Number((amount + fee).toFixed(2))
      return {
        amount_myr: amount,
        fee_myr: fee,
        total_charged_myr: total,
        label: `RM${formatMoney(amount)}`,
        fee_label: `RM${formatMoney(fee)}`,
        total_label: `RM${formatMoney(total)}`
      }
    })
    res.json({ success: true, data: options })
  } catch (error) {
    console.error('Topup options failed', error)
    res.status(500).json({ success: false, error: 'Could not load topup options' })
  }
})

router.post('/', auth, async (req, res) => {
  try {
    if (!stripeEnabled(res)) return

    const amountMyr = Number(req.body.amount_myr)
    if (!TOPUP_AMOUNTS.includes(amountMyr)) {
      return res.status(400).json({ success: false, error: 'Invalid topup amount' })
    }

    const feeMyr = Number((amountMyr * 0.02).toFixed(2))
    const totalChargedMyr = Number((amountMyr + feeMyr).toFixed(2))

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const insertResult = await client.query(
        `INSERT INTO topup_sessions (user_id, amount_myr, fee_myr, total_charged_myr, status, created_at)
         VALUES ($1, $2, $3, $4, 'PENDING', NOW()) RETURNING id`,
        [req.userId, amountMyr, feeMyr, totalChargedMyr]
      )

      const topupSessionId = insertResult.rows[0].id

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['fpx'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'myr',
              product_data: { name: `Topup Wallet — RM${formatMoney(amountMyr)}` },
              unit_amount: Math.round(amountMyr * 100)
            },
            quantity: 1
          },
          {
            price_data: {
              currency: 'myr',
              product_data: { name: 'Processing Fee (2%)' },
              unit_amount: Math.round(feeMyr * 100)
            },
            quantity: 1
          }
        ],
        success_url: `${process.env.FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`,
        metadata: {
          type: 'TOPUP',
          topup_session_id: String(topupSessionId),
          user_id: String(req.userId),
          amount_myr: formatMoney(amountMyr),
          fee_myr: formatMoney(feeMyr),
          total_myr: formatMoney(totalChargedMyr)
        }
      })

      await client.query(
        'UPDATE topup_sessions SET stripe_session_id=$1 WHERE id=$2',
        [session.id, topupSessionId]
      )

      await client.query('COMMIT')
      res.json({
        success: true,
        redirectUrl: session.url,
        breakdown: {
          amount_myr: amountMyr,
          fee_myr: feeMyr,
          total_charged_myr: totalChargedMyr
        }
      })
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('Topup creation failed', error)
      res.status(500).json({ success: false, error: 'Could not create topup session' })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Topup request validation failed', error)
    res.status(400).json({ success: false, error: 'Invalid request body' })
  }
})

async function handleTopupWebhook(req, res) {
  if (!stripe) {
    console.error('Missing STRIPE_SECRET_KEY for topup webhook')
    return res.status(500).json({ error: 'Payment configuration missing' })
  }

  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (error) {
    console.error('Topup webhook signature verification failed', error.message || error)
    return res.status(400).send(`Webhook Error: ${error.message}`)
  }

  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true })
  }

  const session = event.data.object
  if (session.payment_status !== 'paid') {
    return res.json({ received: true })
  }

  const metadata = session.metadata || {}
  if (metadata.type !== 'TOPUP') {
    return res.json({ received: true })
  }

  const stripeSessionId = session.id
  const topupSessionId = Number(metadata.topup_session_id)
  const userId = Number(metadata.user_id)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const topupResult = await client.query(
      'SELECT id, status, amount_myr FROM topup_sessions WHERE stripe_session_id=$1 FOR UPDATE',
      [stripeSessionId]
    )

    if (topupResult.rows.length === 0) {
      await client.query('COMMIT')
      return res.json({ received: true })
    }

    const topup = topupResult.rows[0]
    if (topup.status === 'SUCCESS') {
      await client.query('COMMIT')
      return res.json({ received: true })
    }

    const amountMyr = Number(topup.amount_myr || 0)

    await client.query(
      `UPDATE topup_sessions
       SET status='SUCCESS', stripe_payment_intent=$1, completed_at=NOW()
       WHERE id=$2`,
      [session.payment_intent || null, topup.id]
    )

    await client.query(
      'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
      [amountMyr, userId]
    )

    await client.query(
      'INSERT INTO wallet_transactions (user_id, type, amount, note, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [userId, 'TOPUP', amountMyr, `Topup session ${topupSessionId}`]
    )

    await client.query('COMMIT')
    return res.json({ received: true })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Topup webhook processing failed', error)
    return res.status(500).json({ error: 'Webhook processing failed' })
  } finally {
    client.release()
  }
}

router.post('/webhook', handleTopupWebhook)

module.exports = {
  router,
  webhook: handleTopupWebhook
}
