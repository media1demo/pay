import { Webhooks } from '@dodopayments/express';
import DodoPayments from 'dodopayments';

// In-memory storage. This will reset when your Cloudflare Worker sleeps or redeploys.
// For a real application, you would use a persistent database like Cloudflare D1 or KV storage.
let userSubscriptions = {};
let userProducts = {};

const EXISTING_PRODUCT_ID = 'pdt_Wi9yels9t5RHrfN4BjxNw'; // Your product ID

// This is the main function Cloudflare will run for every request.
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;

    // --- Simple Router Logic ---

    // 1. Home Page Route ("/")
    if (url.pathname === '/' && method === 'GET') {
        const email = url.searchParams.get('email');

        if (email) {
            const subscription = userSubscriptions[email];
            const products = userProducts[email] || [];
            const hasActiveSubscription = subscription && subscription.status === 'active';
            const hasProducts = products.length > 0;

            if (hasActiveSubscription || hasProducts) {
                let accessHtml = `<h1>Welcome Back, ${email}!</h1><p>You have access to the following:</p>`;
                if (hasActiveSubscription) {
                    accessHtml += `
                        <div class="product-card">
                            <h3>Active Subscription</h3>
                            <p><strong>Product ID:</strong> ${subscription.product_id}</p>
                            <p><strong>Status:</strong> ${subscription.status}</p>
                            <p><strong>Next Billing Date:</strong> ${new Date(subscription.next_billing_date).toLocaleDateString()}</p>
                        </div>`;
                }
                if (hasProducts) {
                    products.forEach(product => {
                        accessHtml += `
                            <div class="product-card">
                                <h3>One-Time Purchase</h3>
                                <p><strong>Product ID:</strong> ${product.product_id}</p>
                                <p><strong>Purchased On:</strong> ${new Date(product.purchased_at).toLocaleDateString()}</p>
                            </div>`;
                    });
                }
                return new Response(generateHtmlPage("Access Granted", accessHtml), { headers: { 'Content-Type': 'text/html' } });
            } else {
                const buyHtml = `<h1>Welcome, ${email}!</h1><p>You do not have any active products or subscriptions.</p><a href="/checkout/${EXISTING_PRODUCT_ID}?email=${encodeURIComponent(email)}" class="button">Buy Product Now</a>`;
                return new Response(generateHtmlPage("Buy Product", buyHtml), { headers: { 'Content-Type': 'text/html' } });
            }
        } else {
            const emailFormHtml = `<h1>Check Your Access</h1><p>Please enter your email to see your purchases.</p><form action="/" method="GET"><input type="email" name="email" placeholder="Enter your email" required /><br/><button type="submit">Check Access</button></form>`;
            return new Response(generateHtmlPage("Check Access", emailFormHtml), { headers: { 'Content-Type': 'text/html' } });
        }
    }

    // 2. Custom Checkout Redirect Route
    if (url.pathname.startsWith('/checkout/') && method === 'GET') {
        const productId = url.pathname.split('/')[2];
        const email = url.searchParams.get('email');
        const DODO_PAYMENTS_ENVIRONMENT = env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode';
        const DODO_PAYMENTS_RETURN_URL = env.DODO_PAYMENTS_RETURN_URL || `${url.origin}/success`;

        const baseUrl = DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? 'https://checkout.dodopayments.com/buy' : 'https://test.checkout.dodopayments.com/buy';
        let checkoutUrl = `${baseUrl}/${productId}?quantity=1&redirect_url=${encodeURIComponent(DODO_PAYMENTS_RETURN_URL)}`;
        if (email) checkoutUrl += `&email=${encodeURIComponent(email)}`;

        return Response.redirect(checkoutUrl, 302);
    }
    
    // 3. Success Page Route
    if (url.pathname === '/success' && method === 'GET') {
       const payment_id = url.searchParams.get('payment_id');
       const subscription_id = url.searchParams.get('subscription_id');
       const status = url.searchParams.get('status');

       if (status !== 'succeeded' && status !== 'active') {
           return new Response('<h1>Payment Not Successful</h1><p>Your payment did not complete successfully.</p>', { status: 400, headers: { 'Content-Type': 'text/html' } });
       }
       
        const dodoClient = new DodoPayments({
            bearerToken: env.DODO_PAYMENTS_API_KEY,
            environment: env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode',
        });
       
       let customerEmail = 'your customer';
       let accessDetails = '';

       try {
           if (subscription_id) {
               const sub = await dodoClient.subscriptions.retrieve(subscription_id);
               customerEmail = sub.customer?.email;
               accessDetails = `<p>Your subscription for Product ID <strong>${sub.product_id}</strong> is now active!</p>`;
           } else if (payment_id) {
               const payment = await dodoClient.payments.retrieve(payment_id);
               customerEmail = payment.customer?.email;
               const productName = payment.line_items?.[0]?.product_id || 'your product';
               accessDetails = `<p>Your purchase of Product ID <strong>${productName}</strong> was successful!</p>`;
           }
       } catch (e) {
           console.error("Error fetching details on success page:", e);
           // Fallback message if API call fails
            accessDetails = `<p>Your purchase is being processed. You will receive an email confirmation shortly.</p>`;
       }
       
       const successHtml = `
            <h1>Thank You!</h1>
            ${accessDetails}
            <p>A confirmation has been sent to <strong>${customerEmail}</strong>.</p>
            <br>
            <a href="/?email=${encodeURIComponent(customerEmail)}" class="button">View Your Access</a>
        `;
       return new Response(generateHtmlPage("Payment Successful", successHtml), { headers: { 'Content-Type': 'text/html' } });
    }

    // 4. Webhook Handler Route
    if (url.pathname === '/api/webhook' && method === 'POST') {
        const webhookHandler = Webhooks({
            webhookKey: env.DODO_PAYMENTS_WEBHOOK_KEY,
            
            // --- COMPLETE WEBHOOK HANDLERS ---
            onPaymentSucceeded: async (payload) => {
                const email = payload.data.customer?.email;
                if (email && payload.data.product_id) { // Only for one-time payments
                    if (!userProducts[email]) userProducts[email] = [];
                    userProducts[email].push({
                        payment_id: payload.data.payment_id,
                        product_id: payload.data.product_id,
                        purchased_at: new Date(payload.timestamp),
                        amount: payload.data.total_amount,
                        currency: payload.data.currency
                    });
                    console.log(`Webhook: Product access granted for ${email} | Product: ${payload.data.product_id}`);
                }
            },
            onSubscriptionActive: async (payload) => {
                const email = payload.data.customer?.email;
                if (email) {
                    userSubscriptions[email] = {
                        subscription_id: payload.data.subscription_id,
                        product_id: payload.data.product_id,
                        status: 'active',
                        next_billing_date: payload.data.next_billing_date,
                        activated_at: new Date(payload.timestamp),
                        recurring_amount: payload.data.recurring_pre_tax_amount
                    };
                    console.log(`Webhook: Subscription activated for ${email}`);
                }
            },
            onSubscriptionRenewed: async (payload) => {
                const email = payload.data.customer?.email;
                if (email && userSubscriptions[email]) {
                    userSubscriptions[email].status = 'active'; // Ensure status is active on renewal
                    userSubscriptions[email].next_billing_date = payload.data.next_billing_date;
                    console.log(`Webhook: Subscription renewed for ${email}`);
                }
            },
            onSubscriptionCancelled: async (payload) => {
                const email = payload.data.customer?.email;
                if (email && userSubscriptions[email]) {
                    userSubscriptions[email].status = 'cancelled';
                    console.log(`Webhook: Subscription cancelled for ${email}`);
                }
            },
            onSubscriptionFailed: async (payload) => {
                const email = payload.data.customer?.email;
                if (email && userSubscriptions[email]) {
                    userSubscriptions[email].status = 'failed';
                    console.log(`Webhook: Subscription payment failed for ${email}`);
                }
            },
            onPayload: async (payload) => {
                // Generic handler to log all other events
                console.log(`📦 Received Webhook Event: ${payload.type}`);
            }
        });
        
        return webhookHandler(request);
    }
    
    // 5. User Access API Route
    if (url.pathname.startsWith('/api/user/') && method === 'GET') {
        const email = url.pathname.split('/')[3];
        const userAccess = {
            email: email,
            subscriptions: userSubscriptions[email] || null,
            products: userProducts[email] || [],
        };
        return new Response(JSON.stringify(userAccess, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // If no route matches, return a 404
    return new Response('Not Found', { status: 404 });
}

// Helper function to generate full HTML pages
function generateHtmlPage(title, bodyContent) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background-color: #f4f6f8; text-align: center; }
                .container { max-width: 600px; margin: auto; background: #fff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                h1 { color: #333; }
                p { color: #666; }
                a.button, button { background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; display: inline-block; }
                input { padding: 10px; width: 250px; margin-bottom: 20px; border-radius: 5px; border: 1px solid #ccc; }
                .product-card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-top: 20px; text-align: left; }
                strong { color: #212529; }
            </style>
        </head>
        <body><div class="container">${bodyContent}</div></body>
        </html>
    `;
}
