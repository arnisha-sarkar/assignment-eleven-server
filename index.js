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

// middleware
app.use(
  cors({
    // origin: [process.env.CLIENT_DOMAIN],
    origin: ["http://localhost:5173"],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

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
    const usersCollection = db.collection("users");

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
    // app.get("/all-product", async (req, res) => {
    //   try {
    //     const page = parseInt(req.query.page) || 1;
    //     const limit = parseInt(req.query.limit) || 6; // ✅ 2 products per page
    //     const skip = (page - 1) * limit;

    //     const products = await gramentsCollection
    //       .find()
    //       .skip(skip)
    //       .limit(limit)
    //       .toArray();

    //     const totalProducts = await gramentsCollection.countDocuments();

    //     res.send({
    //       products,
    //       totalProducts,
    //     });
    //   } catch (error) {
    //     res.status(500).send({ message: "Server error" });
    //   }
    // });

    app.get("/all-product/:id", async (req, res) => {
      const id = req.params.id;
      const result = await gramentsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // get 6 data on home
    // app.get("/six-card", async (req, res) => {
    //   try {
    //     const result = await gramentsCollection.find().limit(6).toArray();

    //     res.send(result);
    //   } catch (error) {
    //     res.status(500).send({ message: "Failed to fetch products" });
    //   }
    // });

    app.get("/six-card", async (req, res) => {
      try {
        const query = { showOnHome: true };
        const result = await gramentsCollection.find(query).limit(6).toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch products" });
      }
    });

    // delete order
    app.delete("/all-product/:id", async (req, res) => {
      const { id } = req.params;
      const result = await gramentsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send({
        success: true,
        result,
      });
    });

    // Update a product by id
    app.patch("/all-product/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;

        const result = await gramentsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        if (result.modifiedCount > 0) {
          res.send({
            success: true,
            message: "Product updated successfully ✅",
          });
        } else {
          res.send({ success: false, message: "No product updated ❌" });
        }
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ success: false, message: "Server error ❌", error });
      }
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
          image: product?.image,
          createdAt: new Date(),
          // tracking: [
          //   {
          //     date: new Date().toISOString(),
          //     status: "Order Placed",
          //     note: "Order successfully placed",
          //   },
          // ],
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

      res.send({
        transactionId: session.payment_intent,
        orderId: order._id,
      });
    });

    // get all orders for a customer by email
    app.get("/my-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .find({
          customer: email,
        })
        .toArray();
      res.send(result);
    });

    // Single order fetch
    app.get("/orders/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!result)
          return res.status(404).send({ message: "Order not found" });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server Error", error: err.message });
      }
    });

    // get all order for jus admin
    app.get("/all-orders", async (req, res) => {
      const result = await ordersCollection.find().toArray();
      res.send(result);
    });

    // get all orders for a manager by email
    app.get("/manage-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .find({
          "seller.email": email,
        })
        .toArray();
      res.send(result);
    });

    // save or update a user in db
    // app.post("/user", async (req, res) => {
    //   const userData = req.body;
    //   userData.created_at = new Date().toISOString();
    //   userData.lastLoggedIn = new Date().toISOString();
    //   const query = {
    //     email: userData.email,
    //   };
    //   const alreadyExists = await usersCollection.findOne({
    //     query,
    //   });
    //   console.log("user already exist", !!alreadyExists);
    //   if (alreadyExists) {
    //     console.log("updatin user info");
    //     const result = await usersCollection.updateOne(query, {
    //       $set: {
    //         lastLoggedIn,
    //       },
    //     });
    //     return res.send(result);
    //   }
    //   console.log("saving new user info");
    //   const result = await usersCollection.insertOne(userData);
    //   res.send(result);
    // });
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";
      userData.status = "pending";

      const query = {
        email: userData.email,
      };

      const alreadyExists = await usersCollection.findOne(query);
      console.log("User Already Exists---> ", !!alreadyExists);

      if (alreadyExists) {
        console.log("Updating user info......");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      console.log("Saving new user info......");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // get a user's role
    app.get("/user/role/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send({ role: result?.role });
    });

    // get all users for admin
    app.get("/users", verifyJWT, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    // update a user role
    app.patch("/update-role", verifyJWT, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role: role } }
      );
      // await sellerRequestsCollection.deleteOne({ email });
      res.send(result);
    });

    // backend: update user status
    app.patch("/update-status", verifyJWT, async (req, res) => {
      const { email, status } = req.body;
      try {
        const result = await usersCollection.updateOne(
          { email },
          { $set: { status } }
        );
        res.send({ success: true, result });
      } catch (err) {
        res.status(500).send({ success: false, message: err.message });
      }
    });

    // pending order
    app.get("/pending-orders", async (req, res) => {
      try {
        // শুধুমাত্র status === "pending" order গুলো fetch
        const pendingOrders = await ordersCollection
          .find({ status: "pending" })
          .toArray();

        res.send(pendingOrders);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // approve order
    app.get("/approved-orders-list", async (req, res) => {
      const result = await ordersCollection
        .find({ status: "Approved" })
        .toArray();
      res.send(result);
    });

    // backend code
    app.patch("/orders/approve/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { status: "Approved", approvedAt: new Date() },
      };
      const result = await ordersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.patch("/orders/update-tracking/:id", async (req, res) => {
      const id = req.params.id;
      const trackingInfo = req.body;

      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          currentStatus: trackingInfo.status,
          lastLocation: trackingInfo.location,
          lastUpdated: new Date(),
        },

        $push: {
          trackingHistory: {
            ...trackingInfo,
            time: new Date(),
          },
        },
      };

      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // single trackin order
    app.get("/orders/track/:id", async (req, res) => {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      const result = await ordersCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // reject order
    app.patch("/orders/reject/:id", async (req, res) => {
      const id = req.params.id;

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "Rejected",
          },
        }
      );

      res.send(result);
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
