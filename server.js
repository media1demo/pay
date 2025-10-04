import express from 'express';
import { checkoutHandler, Webhooks } from '@dodopayments/express';
import dotenv from 'dotenv';
import DodoPayments from 'dodopayments';

dotenv.config();
const dodoClient = new DodoPayments({
    bearerToken: process.env.DODO_PAYMENTS_API_KEY,
    environment: process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode',
  });
  
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-memory storage for demo
let userSubscriptions = {};
let userProducts = {};

// Your existing product ID
const EXISTING_PRODUCT_ID = 'pdt_Wi9yels9t5RHrfN4BjxNw';

console.log('🚀 Server starting with product ID:', EXISTING_PRODUCT_ID);



app.get('/checkout/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const { email } = req.query; // We only need the email for the return URL
        
        console.log('🔄 Creating checkout session for product:', productId);
        
        const baseUrl = process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' 
            ? 'https://checkout.dodopayments.com/buy' 
            : 'https://test.checkout.dodopayments.com/buy';
            
        // --- THIS PART IS NEW ---
        // We create a URL object to easily add the email to the success redirect
        const successUrl = new URL(process.env.DODO_PAYMENTS_RETURN_URL || `https://${req.get('host')}/success`);
        if (email) {
            successUrl.searchParams.append('email', email);
        }
        const returnUrl = encodeURIComponent(successUrl.toString());
        // --- END OF NEW PART ---

        let checkoutUrl = `${baseUrl}/${productId}?quantity=1&redirect_url=${returnUrl}`;
        
        if (email) checkoutUrl += `&email=${encodeURIComponent(email)}`;
        
        console.log('✅ Redirecting to checkout:', checkoutUrl);
        res.redirect(checkoutUrl);
        
    } catch (error) {
        console.error('❌ Checkout redirect error:', error);
        res.status(500).send(`<h1>Checkout Error</h1><p>${error.message}</p>`);
    }
});


// Keep the original API routes for programmatic access
app.get('/api/checkout', checkoutHandler({
    bearerToken: process.env.DODO_PAYMENTS_API_KEY,
    returnUrl: process.env.DODO_PAYMENTS_RETURN_URL ,
    environment: process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode',
    type: "static"
}));

app.post('/api/checkout', checkoutHandler({
    bearerToken: process.env.DODO_PAYMENTS_API_KEY,
    returnUrl: process.env.DODO_PAYMENTS_RETURN_URL,
    environment: process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode',
    type: "dynamic"
}));

// COMPLETE Webhook Handler
app.post('/api/webhook', Webhooks({
    webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
    
    onPaymentSucceeded: async (payload) => {
        console.log('💰 Payment succeeded:', payload.data.payment_id);
        console.log('📦 Product ID:', payload.data.product_id);
        console.log('👤 Customer Email:', payload.data.customer?.email);
        console.log('💵 Amount:', payload.data.total_amount);
        
        const customerEmail = payload.data.customer?.email;
        if (customerEmail) {
            if (!userProducts[customerEmail]) {
                userProducts[customerEmail] = [];
            }
            userProducts[customerEmail].push({
                payment_id: payload.data.payment_id,
                product_id: payload.data.product_id,
                purchased_at: new Date(),
                status: 'active',
                amount: payload.data.total_amount,
                currency: payload.data.currency
            });
            
            console.log(`✅ Product access granted to ${customerEmail}`);
        }
    },
    
    onSubscriptionActive: async (payload) => {
        console.log('🔄 Subscription activated:', payload.data.subscription_id);
        console.log('📦 Product ID:', payload.data.product_id);
        console.log('👤 Customer Email:', payload.data.customer?.email);
        
        const customerEmail = payload.data.customer?.email;
        if (customerEmail) {
            userSubscriptions[customerEmail] = {
                subscription_id: payload.data.subscription_id,
                product_id: payload.data.product_id,
                status: 'active',
                next_billing_date: payload.data.next_billing_date,
                activated_at: new Date(),
                recurring_amount: payload.data.recurring_pre_tax_amount
            };
            
            console.log(`✅ Subscription activated for ${customerEmail}`);
        }
    },
    
    onSubscriptionRenewed: async (payload) => {
        console.log('🔄 Subscription renewed:', payload.data.subscription_id);
        
        const customerEmail = payload.data.customer?.email;
        if (customerEmail && userSubscriptions[customerEmail]) {
            userSubscriptions[customerEmail].next_billing_date = payload.data.next_billing_date;
            userSubscriptions[customerEmail].last_renewed = new Date();
            
            console.log(`✅ Subscription renewed for ${customerEmail}`);
        }
    },
    
    onSubscriptionFailed: async (payload) => {
        console.log('❌ Subscription failed:', payload.data.subscription_id);
        
        const customerEmail = payload.data.customer?.email;
        if (customerEmail && userSubscriptions[customerEmail]) {
            userSubscriptions[customerEmail].status = 'failed';
            userSubscriptions[customerEmail].failure_reason = payload.data.failure_reason;
        }
    },
    
    onPayload: async (payload) => {
        console.log('📦 Webhook Event:', payload.type);
        console.log('📄 Data:', JSON.stringify(payload.data, null, 2));
        console.log('-----------------------------------');
    }
}));


// =================================================================
// SMART HOME PAGE - REPLACES your old app.get('/')
// =================================================================
app.get('/', (req, res) => {
    const email = req.query.email;

    // If an email is provided in the URL, check their access
    if (email) {
        const subscription = userSubscriptions[email];
        const products = userProducts[email] || [];
        const hasActiveSubscription = subscription && subscription.status === 'active';
        const hasProducts = products.length > 0;

        // If the user has an active subscription or a purchased product
        if (hasActiveSubscription || hasProducts) {
            let accessHtml = '<h1>Welcome Back!</h1><p>You have access to the following:</p>';
            
            if (hasActiveSubscription) {
                accessHtml += `
                    <div class="product-card">
                        <h3>Active Subscription</h3>
                        <p><strong>Product ID:</strong> ${subscription.product_id}</p>
                        <p><strong>Status:</strong> ${subscription.status}</p>
                        <p><strong>Next Billing Date:</strong> ${new Date(subscription.next_billing_date).toLocaleDateString()}</p>
                    </div>
                `;
            }

            if (hasProducts) {
                 products.forEach(product => {
                    accessHtml += `
                        <div class="product-card">
                            <h3>One-Time Purchase</h3>
                            <p><strong>Product ID:</strong> ${product.product_id}</p>
                            <p><strong>Purchased On:</strong> ${new Date(product.purchased_at).toLocaleDateString()}</p>
                        </div>
                    `;
                 });
            }
            
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Access Granted</title>
                    <style>
                        body { font-family: sans-serif; text-align: center; padding: 40px; background-color: #f4f6f8; }
                        .container { max-width: 700px; margin: auto; background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                        .product-card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-top: 20px; text-align: left; }
                        h1 { color: #28a745; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        ${accessHtml}
                    </div>
                </body>
                </html>
            `);
        // If the user has no active access, show the buy button
        } else {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head><title>Buy Product</title></head>
                <body>
                    <h1>Welcome, ${email}!</h1>
                    <p>You do not have any active products or subscriptions.</p>
                    <a href="/checkout/${EXISTING_PRODUCT_ID}?email=${encodeURIComponent(email)}" style="padding:15px 25px; background-color:#007bff; color:white; text-decoration:none; border-radius: 8px;">Buy Product Now</a>
                </body>
                </html>
            `);
        }
    // If no email is provided, ask for it
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Check Access</title>
                 <style>
                    body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f4f6f8;}
                    .container { text-align: center; background: #fff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                    input { padding: 10px; width: 250px; margin-bottom: 20px; border-radius: 5px; border: 1px solid #ccc; }
                    button { padding: 10px 20px; background-color: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Check Your Access</h1>
                    <p>Please enter your email to see your purchases.</p>
                    <form action="/" method="GET">
                        <input type="email" name="email" placeholder="Enter your email" required />
                        <br/>
                        <button type="submit">Check Access</button>
                    </form>
                </div>
            </body>
            </html>
        `);
    }
});

// User access API
app.get('/api/user/:email/access', (req, res) => {
    const email = req.params.email;
    
    const userAccess = {
        email: email,
        subscriptions: userSubscriptions[email] || null,
        products: userProducts[email] || [],
        hasActiveAccess: false,
        accessType: []
    };
    
    if (userAccess.subscriptions && userAccess.subscriptions.status === 'active') {
        userAccess.hasActiveAccess = true;
        userAccess.accessType.push('subscription');
    }
    
    if (userAccess.products.length > 0) {
        userAccess.hasActiveAccess = true;
        userAccess.accessType.push('product');
    }
    
    res.json(userAccess);
});

// Success page

app.get('/success', async (req, res) => {
    const { status, email } = req.query; // We get the email passed back from the redirect

    // First, check if the status is successful
    if (status !== 'succeeded' && status !== 'active') {
        return res.status(400).send(generateHtmlPage(
            "Payment Failed",
            `<h1>Payment Not Successful</h1>
             <p>Your payment status is: <strong>${status || 'unknown'}</strong>.</p>
             <p>Please check your email or contact support if you believe this is an error.</p>
             <a href="/">← Back to Home</a>`
        ));
    }

    // Since the payment was successful, show a generic success message.
    // The webhook will handle granting access in the background.
    const customerEmail = email || 'your email';

    const successHtml = `
        <h1>Thank You!</h1>
        <h2>Your purchase is being processed.</h2>
        <p>Your access will be granted automatically in just a few moments. We've sent a confirmation to <strong>${customerEmail}</strong>.</p>
        <p>You can check your access status on the home page shortly.</p>
        <br>
        <a href="/?email=${encodeURIComponent(customerEmail)}" class="button">View My Access</a>
    `;
    
    res.send(generateHtmlPage("Payment Successful", successHtml));
});

function generateHtmlPage(title, bodyContent) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background-color: #f8f9fa; color: #333; }
                .container { max-width: 600px; margin: auto; background: #fff; border: 1px solid #ddd; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
                h1 { color: #28a745; }
                a { color: #007bff; text-decoration: none; font-weight: bold; }
                strong { color: #212529; }
                .button { background-color: #007bff; color: white; padding: 15px 25px; border-radius: 8px; }
                input { padding: 10px; width: 250px; margin-bottom: 20px; border-radius: 5px; border: 1px solid #ccc; }
                .product-card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-top: 20px; text-align: left; }
            </style>
        </head>
        <body>
            <div class="container">
                ${bodyContent}
            </div>
        </body>
        </html>
    `;
}

app.listen(PORT, () => {
    console.log(`✅ Server is running and listening on http://localhost:${PORT}`);
    console.log('Waiting for incoming requests and webhooks...');
  });
  