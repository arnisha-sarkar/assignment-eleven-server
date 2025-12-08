require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const serviceAccount = require("./serviceKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = 3000;

app.use(cors());
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// mongodb
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.t1cnfqf.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("gramentsDB");
    const gramentsCollection = db.collection("graments");
    const ordersCollection = db.collection("orders");

    // save a grament data in db
    app.post("/add-product", async (req, res) => {
      const productData = req.body;
      const result = await gramentsCollection.insertOne(productData);
      res.send(result);
    });

    // get all product from db
    app.get("/all-product", async (req, res) => {
      const result = await gramentsCollection.find().toArray();
      res.send(result);
    });
    // get single product from db
    app.get("/all-product/:id", async (req, res) => {
      const id = req.params.id;
      const result = await gramentsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // payment endpoint
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: Number(paymentInfo?.price) * 100,
            },
            quantity: Number(paymentInfo?.quantity),
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          productId: paymentInfo?.productId,
          customer: paymentInfo?.customer?.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/product-details/${paymentInfo.productId}`,
      });
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const product = await gramentsCollection.findOne({
        _id: new ObjectId(session.metadata.productId),
      });
      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });
      if (session.status === "complete" && product && !order) {
        // save order data in db
        const orderInfo = {
          productId: session.metadata.productId,
          transactionId: session.payment_intent,
          customer: session.metadata.customer,
          status: "pending",
          seller: product.seller,
          name: product.name,
          category: product.category,
          quantity: 1,
          price: session.amount_total / 100,
        };
        const result = await ordersCollection.insertOne(orderInfo);
        // update product quantity
        await gramentsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.productId),
          },
          { $inc: { quantity: -1 } }
        );
        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
      res.send(
        res.send({
          transactionId: session.payment_intent,
          orderId: order._id,
        })
      );
    });

    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("server is runnin fine!");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
