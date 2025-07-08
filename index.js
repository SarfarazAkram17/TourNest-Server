require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const port = 3000;
const { MongoClient, ServerApiVersion } = require("mongodb");

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Assignment 12 is cooking");
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.or0q8ig.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db('TourNest')
    const usersCollection = db.collection('usersCollection')

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;

      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        const updateResult = await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: new Date().toISOString() } }
        );

        return res.status(200).send({
          message: "User already exists, last_log_in updated",
          updated: updateResult.modifiedCount > 0,
        });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Assignment 12 running on port ${port}`);
});
