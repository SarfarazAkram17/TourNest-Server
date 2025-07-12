require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const port = 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

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
  const verifyJwt = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).send({ message: "Unauthorized access: No token" });
    }

    const token = authHeader.split(" ")[1];

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).send({ message: "Forbidden: Invalid token" });
      }

      if (req.query.email !== decoded.email) {
        return res.status(403).send({ message: "Forbidden: Email mismatch" });
      }
      req.user = decoded;

      next();
    });
  };

  const verifyAdmin = (req, res, next) => {
    if (req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden: Admins only" });
    }
    next();
  };

  const verifyTourist = (req, res, next) => {
    if (req.user.role !== "tourist") {
      return res.status(403).send({ message: "Forbidden: Tourists only" });
    }
    next();
  };

  try {
    await client.connect();

    const db = client.db("TourNest");
    const usersCollection = db.collection("usersCollection");
    const packagesCollection = db.collection("packagesCollection");
    const applicationsCollection = db.collection("applicationsCollection");
    const bookingsCollection = db.collection("bookingsCollection");

    // JWT API
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;
      const user = await usersCollection.findOne({ email });

      const payload = { email: user.email, role: user.role };
      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "1d",
      });

      res.send({ token });
    });

    // users api
    app.get("/users", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const {
          page = 1,
          limit = 10,
          search = "",
          searchType = "name",
          role = "",
        } = req.query;

        const query = {};
        if (search) {
          const regex = new RegExp(search, "i");
          if (searchType === "email") {
            query.email = regex;
          } else {
            query.name = regex;
          }
        }
        if (role) {
          query.role = role;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await usersCollection.countDocuments(query);
        const users = await usersCollection
          .find(query)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.send({ users, total });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users/tour-guide", async (req, res) => {
      try {
        const query = { role: "tour guide" };
        const tourGuides = await usersCollection.find(query).toArray();

        res.send(tourGuides);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

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

    // Packages API
    app.get("/packages", async (req, res) => {
      try {
        const result = await packagesCollection.find().toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch packages" });
      }
    });

    app.get("/packages/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const result = await packagesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!result) {
          return res.status(404).send({ message: "Package not found" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch package", error });
      }
    });

    app.post("/packages", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const newPackage = req.body;
        const result = await packagesCollection.insertOne(newPackage);
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // applications api
    app.get("/applications", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const {
          page = 1,
          limit = 10,
          status = "pending",
          search = "",
          region = "",
        } = req.query;

        const query = { status };

        if (search) {
          query.name = new RegExp(search, "i");
        }
        if (region) {
          query.region = region;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await applicationsCollection.countDocuments(query);

        const applications = await applicationsCollection
          .find(query)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.send({ applications, total });
      } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    app.post("/applications", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const { email } = req.body;

        // Check if already applied
        const exists = await applicationsCollection.findOne({ email });
        if (exists) {
          return res.send({ message: "You have already applied." });
        }

        const newCandidate = req.body;

        const result = await applicationsCollection.insertOne(newCandidate);
        res.send(result);
      } catch (error) {
        res.status(500).json({ message: error.message });
      }
    });

    app.patch("/applications", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const { role, candidate } = req.body;
        const candidateEmail = candidate.email;
        const guideInfo = {
          name: candidate.name,
          email: candidate.email,
          phone: candidate.phone,
          region: candidate.region,
          district: candidate.district,
          experience: candidate.experience,
          languages: candidate.languages,
          age: candidate.age,
          photo: candidate.photo,
          tourGuideAt: new Date().toISOString(),
        };

        if (!candidateEmail || !role) {
          return res.status(400).send({ message: "Email and role required." });
        }

        const updateResult = await usersCollection.updateOne(
          { email: candidateEmail },
          { $set: { role, guideInfo } }
        );

        res.send(updateResult);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to promote user", error: error.message });
      }
    });

    app.delete(
      "/applications/:id",
      verifyJwt,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const result = await applicationsCollection.deleteOne({
            _id: new ObjectId(id),
          });
          res.send(result);
        } catch (error) {
          res.status(500).send({
            message: "Failed to delete application",
            error: error.message,
          });
        }
      }
    );

    // bookings api
    app.get("/bookings", verifyJwt, async (req, res) => {
      try {
        const { email, page = 1, limit = 10, search = "" } = req.query;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const query = {
          touristEmail: email,
        };

        if (search) {
          query.packageName = { $regex: new RegExp(search, "i") };
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const total = await bookingsCollection.countDocuments(query);

        const bookings = await bookingsCollection
          .find(query)
          .sort({ bookingAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.send({ bookings, total });
      } catch (error) {
        res.status(500).send({
          message: "Failed to fetch bookings",
          error: error.message,
        });
      }
    });

    app.post("/bookings", verifyJwt, async (req, res) => {
      const bookingDetails = req.body;
      const { packageId, touristEmail } = bookingDetails;

      try {
        const existingBooking = await bookingsCollection.findOne({
          packageId,
          touristEmail,
          payment_status: "not_paid",
          status: { $ne: "cancelled" },
        });

        if (existingBooking) {
          return res.status(409).send({
            error: true,
            message:
              "You have already booked this package and not completed payment.",
          });
        }

        // If no conflicting booking found, insert new booking
        const result = await bookingsCollection.insertOne(bookingDetails);
        res.send(result);
      } catch (error) {
        res.status(500).send({
          error: true,
          message: "Something went wrong while processing your booking.",
        });
      }
    });

    app.patch("/bookings/:id", verifyJwt, async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;

        if (!status) {
          return res.status(400).send({ message: "Status is required" });
        }

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status,
            updatedAt: new Date().toISOString(),
          },
        };

        const result = await bookingsCollection.updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Booking not found" });
        }

        res.send({
          message: "Booking status updated",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        res.status(500).send({
          message: "Failed to update booking status",
          error: error.message,
        });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Assignment 12 running on port ${port}`);
});
