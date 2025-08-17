require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const port = 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

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

  const verifyTourGuide = (req, res, next) => {
    if (req.user.role !== "tour guide") {
      return res.status(403).send({ message: "Forbidden: Tour guides only" });
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
    const paymentsCollection = db.collection("paymentsCollection");
    const storiesCollection = db.collection("storiesCollection");

    // stripe payment intent
    app.post("/create-payment-intent", verifyJwt, async (req, res) => {
      try {
        const { price } = req.body;

        const paymentIntent = await stripe.paymentIntents.create({
          amount: price * 100,
          currency: "bdt",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

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

    app.get("/random-tour-guides", async (req, res) => {
      try {
        const tourGuides = await usersCollection
          .aggregate([
            { $match: { role: "tour guide" } },
            { $sample: { size: 6 } },
          ])
          .toArray();
        res.send(tourGuides);
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

    app.get("/users/tour-guide/:id", async (req, res) => {
      try {
        const query = { _id: new ObjectId(req.params.id) };
        const tourGuide = await usersCollection.findOne(query);

        res.send(tourGuide);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users/guide-info", verifyJwt, async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) {
          return res
            .status(400)
            .send({ message: "Email query parameter is required" });
        }

        const guideUser = await usersCollection.findOne({
          "guideInfo.email": email,
        });

        if (!guideUser || !guideUser.guideInfo) {
          return res.status(404).send({ message: "Tour guide info not found" });
        }

        res.send(guideUser.guideInfo);
      } catch (error) {
        console.error("Error fetching tour guide info:", error);
        res.status(500).send({ message: "Server error", error: error.message });
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

    app.patch(
      "/users/guide-info",
      verifyJwt,
      verifyTourGuide,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (!email) {
            return res
              .status(400)
              .send({ message: "Email query parameter is required" });
          }

          // Only allow these fields to be updated inside guideInfo
          const allowedFields = [
            "name",
            "phone",
            "region",
            "district",
            "experience",
            "age",
            "bio",
            "languages",
            "photo",
          ];

          const updateGuideInfo = { updatedAt: new Date().toISOString() };
          for (const field of allowedFields) {
            if (field in req.body) {
              updateGuideInfo[`guideInfo.${field}`] = req.body[field];
            }
          }

          const result = await usersCollection.updateOne(
            { email },
            { $set: updateGuideInfo }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({ message: "Guide not found" });
          }

          res.send({
            message: "Guide info updated successfully",
            modified: result.modifiedCount,
          });
        } catch (error) {
          console.error("Error updating guideInfo:", error);
          res
            .status(500)
            .send({ message: "Server error", error: error.message });
        }
      }
    );

    // Packages API
    app.get("/random-packages", async (req, res) => {
      try {
        const packages = await packagesCollection
          .aggregate([{ $sample: { size: 3 } }])
          .toArray();
        res.send(packages);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/packages", async (req, res) => {
      try {
        const page = parseInt(req.query.page);
        const limit = 12;
        const skip = (page - 1) * limit;

        const total = await packagesCollection.countDocuments();

        const packages = await packagesCollection
          .find()
          .sort({ _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({
          packages,
          total,
          limit,
        });
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
          bio: candidate.bio,
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

    app.get("/bookings/:id", verifyJwt, async (req, res) => {
      try {
        const bookingId = req.params.id;

        const booking = await bookingsCollection.findOne({
          _id: new ObjectId(bookingId),
        });

        if (!booking) {
          return res.status(404).send({ message: "Booking not found" });
        }

        res.send(booking);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch booking", error: error.message });
      }
    });

    app.get(
      "/bookings/tourGuide/assigned",
      verifyJwt,
      verifyTourGuide,
      async (req, res) => {
        try {
          const { email, page = 1, limit = 10, search = "" } = req.query;

          if (!email) {
            return res.status(400).send({ message: "Email is required" });
          }

          const query = {
            tourGuideEmail: email,
            status: { $ne: "cancelled" },
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
          res.status(500).send({ message: error.message });
        }
      }
    );

    app.post("/bookings", verifyJwt, async (req, res) => {
      const bookingDetails = req.body;
      const { packageId, touristEmail } = bookingDetails;

      try {
        const existingBooking = await bookingsCollection.findOne({
          packageId,
          touristEmail,
          payment_status: "not_paid",
          status: { $nin: ["cancelled", "rejected"] },
        });

        if (existingBooking) {
          return res.status(409).send({
            error: true,
            message:
              "You have already booked this package and not completed payment.",
          });
        }

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

        if (status === "accepted" || status === "rejected") {
          if (req.user.role !== "tour guide") {
            return res
              .status(403)
              .send({ message: "Forbidden: Tour guides only" });
          }
        }

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

    // payments api
    app.post("/payments", verifyJwt, async (req, res) => {
      try {
        const payment = req.body;
        payment.paymentAt = new Date().toISOString();

        // Save payment record
        const result = await paymentsCollection.insertOne(payment);

        // Update booking status
        const update = await bookingsCollection.updateOne(
          { _id: new ObjectId(payment.bookingId) },
          {
            $set: {
              status: "in review",
              payment_status: "paid",
              updatedAt: new Date().toISOString(),
            },
          }
        );

        res.send({
          insertedId: result.insertedId,
          updatedBooking: update.modifiedCount > 0,
        });
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to process payment", error: error.message });
      }
    });

    // stories api
    app.get("/random-stories", async (req, res) => {
      try {
        const randomStories = await storiesCollection
          .aggregate([{ $sample: { size: 3 } }])
          .toArray();

        res.send(randomStories);
      } catch (error) {
        res.status(500).send({
          message: "Failed to fetch random stories",
          error: error.message,
        });
      }
    });

    app.get("/stories", async (req, res) => {
      try {
        const email = req.query.email;
        const page = parseInt(req.query.page);
        const limit = 12;
        const skip = (page - 1) * limit;

        const query = {};

        if (email) {
          query.email = email;
        }

        const total = await storiesCollection.countDocuments(query);
        const stories = await storiesCollection
          .find(query)
          .sort({ uploadedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({
          total,
          limit,
          stories,
        });
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to fetch stories", error: err.message });
      }
    });

    app.get("/stories/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const story = await storiesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!story) {
          return res.status(404).send({ message: "Story not found" });
        }

        res.send(story);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch story", error: error.message });
      }
    });

    app.post("/stories", verifyJwt, async (req, res) => {
      try {
        const story = req.body;

        if (
          !story.title ||
          !story.description ||
          !story.location ||
          !story.images?.length ||
          !story.name ||
          !story.email ||
          !story.photo ||
          !story.role
        ) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        const newStory = {
          ...story,
          uploadedAt: new Date().toISOString(),
        };

        const result = await storiesCollection.insertOne(newStory);
        res.send(result);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to add story", error: err.message });
      }
    });

    app.patch("/stories/:id", verifyJwt, async (req, res) => {
      try {
        const storyId = req.params.id;
        const {
          title,
          description,
          location,
          imagesToAdd = [],
          imagesToRemove = [],
        } = req.body;

        const query = { _id: new ObjectId(storyId) };
        const story = await storiesCollection.findOne(query);

        if (!story) {
          return res.status(404).json({ error: "Story not found" });
        }

        // Step 1: Apply $set and $pull
        const update1 = {
          $set: {
            title,
            description,
            location,
            updatedAt: new Date().toISOString(),
          },
        };

        if (imagesToRemove.length > 0) {
          update1.$pull = {
            images: { $in: imagesToRemove },
          };
        }

        await storiesCollection.updateOne(query, update1);

        // Step 2: Apply $push (if any)
        if (imagesToAdd.length > 0) {
          const update2 = {
            $push: {
              images: { $each: imagesToAdd },
            },
          };
          await storiesCollection.updateOne(query, update2);
        }

        res.send({ success: true, message: "Story updated successfully" });
      } catch (error) {
        console.error("Error updating story:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    app.delete("/stories/:id", verifyJwt, async (req, res) => {
      try {
        const storyId = req.params.id;

        const result = await storiesCollection.deleteOne({
          _id: new ObjectId(storyId),
        });
        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to delete story.", error: error.message });
      }
    });

    // stats api
    app.get("/admin/stats", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const totalPaymentsResult = await paymentsCollection
          .aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }])
          .toArray();

        const totalTourGuides = await usersCollection.countDocuments({
          role: "tour guide",
        });
        const totalClients = await usersCollection.countDocuments({
          role: "tourist",
        });
        const totalPackages = await packagesCollection.countDocuments();
        const totalStories = await storiesCollection.countDocuments();

        const paymentsTrendData = await paymentsCollection
          .aggregate([
            {
              $group: {
                _id: {
                  year: { $year: { $toDate: "$paymentAt" } },
                  month: { $month: { $toDate: "$paymentAt" } },
                },
                totalPayments: { $sum: "$price" },
              },
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } },
          ])
          .toArray();

        const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];

        const paymentsTrend = paymentsTrendData.map((item) => ({
          month: `${monthNames[item._id.month - 1]} ${item._id.year}`,
          payments: item.totalPayments,
        }));

        res.send({
          totalPayments: totalPaymentsResult[0]?.total || 0,
          paymentsTrend,
          totalTourGuides,
          totalClients,
          totalPackages,
          totalStories,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/tourist/stats", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const email = req.query.email;
        if (!email)
          return res.status(400).send({ message: "Email is required" });

        const today = new Date();

        // Fetch all bookings for this tourist
        const bookings = await bookingsCollection
          .find({ touristEmail: email })
          .toArray();

        // Fetch all package info for the booked packages
        const packageIds = bookings.map((b) => b.packageId);
        const packages = await packagesCollection
          .find({ _id: { $in: packageIds.map((id) => new ObjectId(id)) } })
          .toArray();

        // Fetch all package info for the booked packages
        const bookingIds = bookings.map((b) => b._id.toString());
        const payments = await paymentsCollection
          .find({ bookingId: { $in: bookingIds } })
          .toArray();

        const totalBookings = bookings.length;
        let upcomingTours = 0;
        let completedTours = 0;
        let cancelledTours = 0;
        let rejectedTours = 0;
        let pendingPayments = 0;
        let totalSpent = 0;

        const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        const monthlySpendingMap = {}; // For line chart
        const spentPerPackageMap = {}; // For bar chart

        const detailedBookings = bookings.map(async (booking) => {
          const pkg = packages.find(
            (p) => p._id.toString() === booking.packageId
          );
          const tourPlanLength = pkg?.tourPlan?.length || 1;

          const tourStart = new Date(booking.tourDate);
          const tourEnd = new Date(tourStart);
          tourEnd.setDate(tourEnd.getDate() + tourPlanLength);

          const status = booking.status;
          const paymentStatus = booking.payment_status;

          const isUpcoming =
            tourStart > today && ["accepted", "in review"].includes(status);
          const isCompleted = tourEnd < today && status === "accepted";
          const isCancelled = status === "cancelled";
          const isRejected = status === "rejected";
          const isPendingPayment =
            !["cancelled", "rejected"].includes(status) &&
            paymentStatus !== "paid";

          if (isUpcoming) upcomingTours++;
          if (isCompleted) completedTours++;
          if (isCancelled) cancelledTours++;
          if (isRejected) rejectedTours++;
          if (isPendingPayment) pendingPayments++;
          if (paymentStatus === "paid") totalSpent += booking.price;

          // Monthly spending
          if (paymentStatus === "paid") {
            const payment = payments.find(
              (p) => p.bookingId === booking._id.toString()
            );
            const monthKey = `${
              monthNames[new Date(payment.paymentAt).getMonth()]
            } ${new Date(payment.paymentAt).getFullYear()}`;
            monthlySpendingMap[monthKey] =
              (monthlySpendingMap[monthKey] || 0) + booking.price;
          }

          // Spending per package
          if (paymentStatus === "paid") {
            spentPerPackageMap[pkg?.title || booking.packageName] =
              (spentPerPackageMap[pkg?.title || booking.packageName] || 0) +
              booking.price;
          }

          return {
            bookingId: booking._id,
            packageId: booking.packageId,
            packageName: pkg?.title || booking.packageName,
            tourDate: booking.tourDate,
            tourGuideName: booking.tourGuideName,
            tourGuideImage: booking.tourGuideImage,
            price: booking.price,
            payment_status: booking.payment_status,
            status: booking.status,
            isUpcoming,
            isCompleted,
            isCancelled,
            isRejected,
            isPendingPayment,
          };
        });

        // Convert monthly spending map to array for charts
        const monthlySpending = Object.entries(monthlySpendingMap).map(
          ([month, total]) => ({ month, total })
        );

        // Helper to parse "Aug 2025" into a sortable date
        const parseMonthYear = (str) => {
          const [mon, year] = str.split(" ");
          const monthIndex = monthNames.indexOf(mon);
          return new Date(parseInt(year), monthIndex, 1);
        };

        // Sort by year then month
        monthlySpending.sort(
          (a, b) => parseMonthYear(a.month) - parseMonthYear(b.month)
        );

        const spentPerPackage = Object.entries(spentPerPackageMap).map(
          ([pkg, spent]) => ({ package: pkg, spent })
        );

        const tourDistribution = [
          { name: "Upcoming", value: upcomingTours },
          { name: "Completed", value: completedTours },
          { name: "Cancelled", value: cancelledTours },
          { name: "Rejected", value: rejectedTours },
        ];

        res.send({
          stats: {
            totalBookings,
            upcomingTours,
            completedTours,
            cancelledTours,
            rejectedTours,
            pendingPayments,
            totalSpent,
          },
          monthlySpending,
          spentPerPackage,
          tourDistribution,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get(
      "/tourGuide/stats",
      verifyJwt,
      verifyTourGuide,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (!email) {
            return res.status(400).send({ message: "Email is required" });
          }

          const today = new Date();

          // Fetch all bookings assigned to this tour guide
          const bookings = await bookingsCollection
            .find({ tourGuideEmail: email })
            .toArray();

          // Fetch all package info to get tourPlan length
          const packageIds = bookings.map((b) => b.packageId);
          const packages = await packagesCollection
            .find({ _id: { $in: packageIds.map((id) => new ObjectId(id)) } })
            .toArray();

          let totalBookings = bookings.length;
          let upcomingTours = 0;
          let completedTours = 0;
          let rejectedTours = 0;

          const packageCountMap = {}; // Count tours per package

          bookings.forEach((booking) => {
            const pkg = packages.find(
              (p) => p._id.toString() === booking.packageId
            );
            const tourPlanLength = pkg?.tourPlan?.length || 1;

            const tourStart = new Date(booking.tourDate);
            const tourEnd = new Date(tourStart);
            tourEnd.setDate(tourEnd.getDate() + tourPlanLength);

            const status = booking.status;

            // Upcoming: bookingAt in future, status accepted or in review
            if (
              tourStart > today &&
              (status === "accepted" || status === "in review")
            ) {
              upcomingTours++;
            }

            // Completed: tourEnd < today and status accepted
            if (tourEnd < today && status === "accepted") {
              completedTours++;
            }

            // Cancelled / Rejected
            if (status === "rejected") {
              rejectedTours++;
            }

            // Count per package (exclude cancelled/rejected)
            if (
              booking.packageName &&
              status !== "cancelled" &&
              status !== "rejected"
            ) {
              packageCountMap[booking.packageName] =
                (packageCountMap[booking.packageName] || 0) + 1;
            }
          });

          // Prepare tour distribution for pie chart
          const tourDistribution = [
            { name: "Completed", value: completedTours },
            { name: "Upcoming", value: upcomingTours },
            { name: "Rejected", value: rejectedTours },
          ];

          // Prepare tours per package for bar chart
          const toursPerPackage = Object.entries(packageCountMap).map(
            ([packageName, count]) => ({
              package: packageName,
              count,
            })
          );

          res.send({
            stats: {
              totalBookings,
              upcomingTours,
              completedTours,
              rejectedTours,
            },
            tourDistribution,
            toursPerPackage,
          });
        } catch (error) {
          res
            .status(500)
            .send({ message: "Server error", error: error.message });
        }
      }
    );

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Assignment 12 running on port ${port}`);
});
