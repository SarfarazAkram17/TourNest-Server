require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const dns = require("dns");

dns.setServers(["1.1.1.1", "8.8.8.8"]);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send("TourNest API is running");
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.or0q8ig.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toInt = (value, fallback, min = 1, max = 100) => {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};
const str = (value, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const isId = (id) => typeof id === "string" && ObjectId.isValid(id) && String(new ObjectId(id)) === id;
const nowISO = () => new Date().toISOString();

const bookingEnd = (booking) =>
  new Date(new Date(booking.tourDate).getTime() + (Number(booking.durationDays) || 1) * DAY_MS);
const isCompleted = (booking) => booking.status === "accepted" && bookingEnd(booking) < new Date();
const isUpcoming = (booking) =>
  (booking.status === "accepted" || booking.status === "in review") && !isCompleted(booking);

const monthKey = (date) => date.getFullYear() * 12 + date.getMonth();
const monthLabel = (key) => `${MONTHS[key % 12]} ${Math.floor(key / 12)}`;

const sumByMonth = (items, getDate, getValue) => {
  const map = new Map();
  items.forEach((item) => {
    const date = new Date(getDate(item));
    if (Number.isNaN(date.getTime())) return;
    const key = monthKey(date);
    map.set(key, (map.get(key) || 0) + getValue(item));
  });
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-12)
    .map(([key, value]) => ({ key, value, month: monthLabel(key) }));
};

/* ------------------------------------------------------------------ */
/*  Firebase identity verification                                     */
/*  Set FIREBASE_PROJECT_ID to require a valid Firebase ID token when  */
/*  creating users and exchanging for a TourNest JWT.                  */
/* ------------------------------------------------------------------ */
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let certCache = { certs: null, expires: 0 };
let warnedAboutIdentity = false;

const getFirebaseCerts = async () => {
  if (certCache.certs && Date.now() < certCache.expires) return certCache.certs;
  const response = await fetch(FIREBASE_CERT_URL);
  const certs = await response.json();
  const match = /max-age=(\d+)/.exec(response.headers.get("cache-control") || "");
  certCache = { certs, expires: Date.now() + (match ? Number(match[1]) : 3600) * 1000 };
  return certs;
};

const verifyFirebaseIdToken = async (idToken) => {
  const decoded = jwt.decode(idToken, { complete: true });
  const cert = (await getFirebaseCerts())[decoded?.header?.kid];
  if (!cert) throw new Error("Unknown signing key");
  return jwt.verify(idToken, cert, {
    algorithms: ["RS256"],
    audience: FIREBASE_PROJECT_ID,
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
  });
};

const identify = async (req, res, next) => {
  if (!FIREBASE_PROJECT_ID) {
    if (!warnedAboutIdentity) {
      warnedAboutIdentity = true;
      console.warn(
        "FIREBASE_PROJECT_ID is not set: sign-in identity is NOT verified. Set it before going to production.",
      );
    }
    req.identity = { email: str(req.body?.email, 200) };
    return next();
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized: Firebase ID token required" });
  }
  try {
    const decoded = await verifyFirebaseIdToken(header.split(" ")[1]);
    req.identity = { email: decoded.email, name: decoded.name, picture: decoded.picture };
    next();
  } catch (error) {
    res.status(401).send({ message: "Unauthorized: Invalid Firebase ID token" });
  }
};

async function run() {
  // assigned once the database connection is ready
  let usersCollection;

  const verifyJwt = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({ message: "Unauthorized access: No token" });
    }

    let decoded;
    try {
      decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    } catch (err) {
      const expired = err.name === "TokenExpiredError";
      return res
        .status(expired ? 401 : 403)
        .send({ message: expired ? "Session expired: please log in again" : "Forbidden: Invalid token" });
    }

    if (req.query.email !== decoded.email) {
      return res.status(403).send({ message: "Forbidden: Email mismatch" });
    }

    // The role always comes from the database, so promotions apply immediately.
    const dbUser = await usersCollection.findOne({ email: decoded.email }, { projection: { role: 1 } });
    if (!dbUser) {
      return res.status(401).send({ message: "Unauthorized: Account not found" });
    }

    req.user = { email: decoded.email, role: dbUser.role };
    next();
  };

  const requireRole = (role, label) => (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).send({ message: `Forbidden: ${label} only` });
    }
    next();
  };
  const verifyAdmin = requireRole("admin", "Admins");
  const verifyTourist = requireRole("tourist", "Tourists");
  const verifyTourGuide = requireRole("tour guide", "Tour guides");

  try {
    await client.connect();

    const db = client.db("TourNest");
    usersCollection = db.collection("usersCollection");
    const packagesCollection = db.collection("packagesCollection");
    const applicationsCollection = db.collection("applicationsCollection");
    const bookingsCollection = db.collection("bookingsCollection");
    const paymentsCollection = db.collection("paymentsCollection");
    const storiesCollection = db.collection("storiesCollection");

    /* ---------------------------------------------------------------- */
    /*  Session                                                         */
    /* ---------------------------------------------------------------- */
    app.post("/jwt", identify, async (req, res) => {
      try {
        const email = req.identity.email;
        if (!email) return res.status(400).send({ message: "Email is required" });

        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: "User not found" });

        const token = jwt.sign({ email: user.email, role: user.role }, process.env.JWT_SECRET, {
          expiresIn: "1d",
        });
        res.send({ token });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    /* ---------------------------------------------------------------- */
    /*  Users                                                           */
    /* ---------------------------------------------------------------- */
    app.post("/users", identify, async (req, res) => {
      try {
        const email = req.identity.email;
        if (!email) return res.status(400).send({ message: "Email is required" });

        const existing = await usersCollection.findOne({ email });
        if (existing) {
          const update = { last_log_in: nowISO() };
          const photo = str(req.body.photo);
          if (!existing.photo && photo) update.photo = photo;
          await usersCollection.updateOne({ email }, { $set: update });
          return res.status(200).send({ message: "User already exists, last_log_in updated" });
        }

        // The role is never taken from the client: everyone starts as a tourist.
        const result = await usersCollection.insertOne({
          name: str(req.body.name, 80) || req.identity.name || email.split("@")[0],
          email,
          photo: str(req.body.photo) || req.identity.picture || "",
          role: "tourist",
          createdAt: nowISO(),
          last_log_in: nowISO(),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const page = toInt(req.query.page, 1, 1, 100000);
        const limit = toInt(req.query.limit, 10, 1, 50);
        const search = str(req.query.search, 100);
        const searchType = req.query.searchType === "email" ? "email" : "name";
        const role = str(req.query.role, 20);

        const query = {};
        if (search) query[searchType] = new RegExp(escapeRegex(search), "i");
        if (role) query.role = role;

        const [total, users, roleCounts] = await Promise.all([
          usersCollection.countDocuments(query),
          usersCollection
            .find(query, { projection: { name: 1, email: 1, role: 1, photo: 1, createdAt: 1, created_at: 1 } })
            .sort({ _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
          usersCollection.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]).toArray(),
        ]);

        const counts = { all: 0 };
        roleCounts.forEach((r) => {
          counts[r._id] = r.count;
          counts.all += r.count;
        });

        res.send({ users, total, counts });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.params.email }, { projection: { role: 1 } });
        if (!user) return res.status(404).send({ message: "User not found" });
        res.send({ role: user.role });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/random-tour-guides", async (req, res) => {
      try {
        const guides = await usersCollection
          .aggregate([{ $match: { role: "tour guide" } }, { $sample: { size: 6 } }])
          .toArray();
        res.send(guides);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users/tour-guide", async (req, res) => {
      try {
        res.send(await usersCollection.find({ role: "tour guide" }).toArray());
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users/tour-guide/:id", async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const guide = await usersCollection.findOne({ _id: new ObjectId(req.params.id), role: "tour guide" });
        if (!guide) return res.status(404).send({ message: "Tour guide not found" });
        res.send(guide);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/users/guide-info", verifyJwt, verifyTourGuide, async (req, res) => {
      try {
        const guideUser = await usersCollection.findOne({ "guideInfo.email": req.user.email });
        if (!guideUser || !guideUser.guideInfo) {
          return res.status(404).send({ message: "Tour guide info not found" });
        }
        res.send(guideUser.guideInfo);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.patch("/users/guide-info", verifyJwt, verifyTourGuide, async (req, res) => {
      try {
        const body = req.body || {};
        const update = { updatedAt: nowISO() };

        const textFields = { name: 80, phone: 30, region: 60, district: 60, bio: 2000, photo: 500 };
        for (const [field, max] of Object.entries(textFields)) {
          if (field in body) {
            const value = str(body[field], max);
            if (!value) return res.status(400).send({ message: `${field} cannot be empty` });
            update[`guideInfo.${field}`] = value;
          }
        }
        for (const field of ["experience", "age"]) {
          if (field in body) {
            const value = Number(body[field]);
            if (!Number.isFinite(value) || value < 0 || value > 120) {
              return res.status(400).send({ message: `${field} is invalid` });
            }
            update[`guideInfo.${field}`] = value;
          }
        }
        if ("languages" in body) {
          const languages = Array.isArray(body.languages)
            ? body.languages.map((l) => str(l, 40)).filter(Boolean).slice(0, 12)
            : [];
          if (!languages.length) return res.status(400).send({ message: "languages cannot be empty" });
          update["guideInfo.languages"] = languages;
        }

        const result = await usersCollection.updateOne({ email: req.user.email }, { $set: update });
        if (result.matchedCount === 0) return res.status(404).send({ message: "Guide not found" });

        res.send({ message: "Guide info updated successfully", modified: result.modifiedCount });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    /* ---------------------------------------------------------------- */
    /*  Packages                                                        */
    /* ---------------------------------------------------------------- */
    app.get("/random-packages", async (req, res) => {
      try {
        res.send(await packagesCollection.aggregate([{ $sample: { size: 3 } }]).toArray());
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/packages/types", async (req, res) => {
      try {
        const raw = await packagesCollection.distinct("tourType");
        const seen = new Map();
        raw.forEach((t) => {
          const label = str(t, 60);
          if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
        });
        res.send([...seen.values()].sort((a, b) => a.localeCompare(b)));
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/packages", async (req, res) => {
      try {
        const page = toInt(req.query.page, 1, 1, 100000);
        const limit = 12;
        const search = str(req.query.search, 100);
        const type = str(req.query.type, 60);
        const sort = str(req.query.sort, 20);

        const query = {};
        if (search) {
          const regex = new RegExp(escapeRegex(search), "i");
          query.$or = [{ title: regex }, { location: regex }];
        }
        if (type) query.tourType = new RegExp(`^${escapeRegex(type)}$`, "i");

        const sortBy =
          sort === "price-asc" ? { price: 1, _id: -1 } : sort === "price-desc" ? { price: -1, _id: -1 } : { _id: -1 };

        const [total, packages] = await Promise.all([
          packagesCollection.countDocuments(query),
          packagesCollection
            .find(query)
            .sort(sortBy)
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        ]);

        res.send({ packages, total, limit });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch packages" });
      }
    });

    app.get("/packages/:id", async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const result = await packagesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!result) return res.status(404).send({ message: "Package not found" });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch package" });
      }
    });

    const buildPackage = (body = {}) => {
      const images = Array.isArray(body.images) ? body.images.map((i) => str(i)).filter(Boolean).slice(0, 10) : [];
      const tourPlan = Array.isArray(body.tourPlan)
        ? body.tourPlan
            .map((p, i) => ({ day: str(p?.day, 40) || `Day ${i + 1}`, activities: str(p?.activities, 3000) }))
            .filter((p) => p.activities)
        : [];
      const pkg = {
        tourType: str(body.tourType, 60),
        title: str(body.title, 150),
        location: str(body.location, 120),
        duration: str(body.duration, 60),
        description: str(body.description, 5000),
        price: Number(body.price),
        images,
        tourPlan,
      };
      const valid =
        pkg.tourType &&
        pkg.title &&
        pkg.location &&
        pkg.duration &&
        pkg.description &&
        Number.isFinite(pkg.price) &&
        pkg.price > 0 &&
        images.length &&
        tourPlan.length;
      return valid ? pkg : null;
    };

    app.post("/packages", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const pkg = buildPackage(req.body);
        if (!pkg) return res.status(400).send({ message: "Please complete every package field." });
        const result = await packagesCollection.insertOne({ ...pkg, createdAt: nowISO() });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.patch("/packages/:id", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const pkg = buildPackage(req.body);
        if (!pkg) return res.status(400).send({ message: "Please complete every package field." });

        // Bookings keep the title, image and price they were made with.
        const result = await packagesCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { ...pkg, updatedAt: nowISO() } },
        );
        if (result.matchedCount === 0) return res.status(404).send({ message: "Package not found" });
        res.send({ message: "Package updated", modifiedCount: result.modifiedCount });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.delete("/packages/:id", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });

        // Refuse while travelers still have an unfinished booking for this package.
        const open = await bookingsCollection
          .find({ packageId: req.params.id, status: { $in: ["pending", "in review", "accepted"] } })
          .toArray();
        const active = open.filter((b) => !isCompleted(b));
        if (active.length) {
          return res.status(409).send({
            message: `This package has ${active.length} active booking${active.length === 1 ? "" : "s"}. Wait until they finish or are cancelled before deleting it.`,
          });
        }

        const result = await packagesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        if (result.deletedCount === 0) return res.status(404).send({ message: "Package not found" });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    /* ---------------------------------------------------------------- */
    /*  Guide applications                                              */
    /* ---------------------------------------------------------------- */
    app.get("/applications", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const page = toInt(req.query.page, 1, 1, 100000);
        const limit = toInt(req.query.limit, 10, 1, 50);
        const search = str(req.query.search, 100);
        const region = str(req.query.region, 60);

        const query = { status: str(req.query.status, 20) || "pending" };
        if (search) query.name = new RegExp(escapeRegex(search), "i");
        if (region) query.region = region;

        const [total, applications] = await Promise.all([
          applicationsCollection.countDocuments(query),
          applicationsCollection
            .find(query)
            .sort({ _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        ]);

        res.send({ applications, total });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/applications/mine", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const application = await applicationsCollection.findOne({ email: req.user.email });
        res.send({ application: application || null });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.post("/applications", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const email = req.user.email;
        const exists = await applicationsCollection.findOne({ email });
        if (exists) return res.send({ message: "You have already applied." });

        const body = req.body || {};
        const application = {
          name: str(body.name, 80),
          email,
          photo: str(body.photo),
          phone: str(body.phone, 30),
          applicationTitle: str(body.applicationTitle, 150),
          reason: str(body.reason, 2000),
          cvLink: str(body.cvLink, 500),
          region: str(body.region, 60),
          district: str(body.district, 60),
          experience: Number(body.experience),
          age: Number(body.age),
          languages: Array.isArray(body.languages) ? body.languages.map((l) => str(l, 40)).filter(Boolean).slice(0, 12) : [],
          bio: str(body.bio, 2000),
        };

        const missing =
          !application.name ||
          !application.phone ||
          !application.applicationTitle ||
          !application.reason ||
          !/^https?:\/\//i.test(application.cvLink) ||
          !application.region ||
          !application.district ||
          !Number.isFinite(application.experience) ||
          application.experience < 0 ||
          !Number.isFinite(application.age) ||
          application.age < 18 ||
          !application.languages.length ||
          !application.bio;
        if (missing) return res.status(400).send({ message: "Please complete every field correctly." });

        const result = await applicationsCollection.insertOne({
          ...application,
          status: "pending",
          createdAt: nowISO(),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Approve: promote the applicant to tour guide and remove the application.
    app.patch("/applications", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const { applicationId } = req.body || {};
        if (!isId(applicationId)) return res.status(400).send({ message: "A valid applicationId is required." });

        const application = await applicationsCollection.findOne({ _id: new ObjectId(applicationId) });
        if (!application) return res.status(404).send({ message: "Application not found." });

        const guideInfo = {
          name: application.name,
          email: application.email,
          phone: application.phone,
          region: application.region,
          district: application.district,
          experience: application.experience,
          languages: application.languages,
          age: application.age,
          photo: application.photo,
          bio: application.bio,
          tourGuideAt: nowISO(),
        };

        const result = await usersCollection.updateOne(
          { email: application.email },
          { $set: { role: "tour guide", guideInfo } },
        );
        if (result.matchedCount === 0) return res.status(404).send({ message: "Applicant account not found." });

        await applicationsCollection.deleteOne({ _id: application._id });
        res.send({ message: "Applicant promoted to tour guide.", modifiedCount: result.modifiedCount });
      } catch (error) {
        res.status(500).send({ message: "Failed to promote user", error: error.message });
      }
    });

    app.delete("/applications/:id", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        res.send(await applicationsCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
      } catch (error) {
        res.status(500).send({ message: "Failed to delete application", error: error.message });
      }
    });

    /* ---------------------------------------------------------------- */
    /*  Bookings                                                        */
    /*  pending -> in review (paid) -> accepted, or rejected/cancelled  */
    /* ---------------------------------------------------------------- */
    const statusFilter = (status) => {
      if (!status || status === "all") return null;
      if (status === "unpaid") return { status: "pending", payment_status: "not_paid" };
      return { status };
    };

    app.get("/bookings", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const page = toInt(req.query.page, 1, 1, 100000);
        const limit = toInt(req.query.limit, 10, 1, 50);
        const search = str(req.query.search, 100);

        const query = { touristEmail: req.user.email, ...statusFilter(str(req.query.status, 20)) };
        if (search) query.packageName = new RegExp(escapeRegex(search), "i");

        const [total, bookings, paidTotal] = await Promise.all([
          bookingsCollection.countDocuments(query),
          bookingsCollection
            .find(query)
            .sort({ bookingAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
          bookingsCollection.countDocuments({ touristEmail: req.user.email, payment_status: "paid" }),
        ]);

        res.send({ bookings, total, paidTotal });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch bookings", error: error.message });
      }
    });

    app.get("/bookings/tourGuide/assigned", verifyJwt, verifyTourGuide, async (req, res) => {
      try {
        const page = toInt(req.query.page, 1, 1, 100000);
        const limit = toInt(req.query.limit, 10, 1, 50);
        const search = str(req.query.search, 100);
        const status = str(req.query.status, 20);

        const query = { tourGuideEmail: req.user.email, status: { $ne: "cancelled" } };
        if (status && status !== "all") query.status = status;
        if (search) query.packageName = new RegExp(escapeRegex(search), "i");

        const [total, bookings] = await Promise.all([
          bookingsCollection.countDocuments(query),
          bookingsCollection
            .find(query)
            .sort({ bookingAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        ]);

        res.send({ bookings, total });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/bookings/:id", verifyJwt, verifyTourist, async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const booking = await bookingsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!booking) return res.status(404).send({ message: "Booking not found" });

        if (booking.touristEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden: Not your booking" });
        }

        res.send(booking);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch booking", error: error.message });
      }
    });

    app.post("/bookings", verifyJwt, async (req, res) => {
      try {
        if (req.user.role !== "tourist") {
          return res.status(403).send({ message: "Only tourist accounts can book trips." });
        }

        const body = req.body || {};
        const { packageId } = body;
        const tourGuideEmail = str(body.tourGuideEmail, 200);
        const tourDate = new Date(body.tourDate);
        const tourDay = /^\d{4}-\d{2}-\d{2}$/.test(body.tourDay || "") ? body.tourDay : tourDate.toISOString().slice(0, 10);

        if (!isId(packageId)) return res.status(400).send({ message: "A valid package is required." });
        if (Number.isNaN(tourDate.getTime()) || tourDate <= new Date()) {
          return res.status(400).send({ message: "Choose a travel date in the future." });
        }
        if (!tourGuideEmail || tourGuideEmail === req.user.email) {
          return res.status(400).send({ message: "Choose a tour guide other than yourself." });
        }

        const [pkg, guide, tourist] = await Promise.all([
          packagesCollection.findOne({ _id: new ObjectId(packageId) }),
          usersCollection.findOne({ email: tourGuideEmail, role: "tour guide" }),
          usersCollection.findOne({ email: req.user.email }),
        ]);
        if (!pkg) return res.status(404).send({ message: "Package not found." });
        if (!guide) return res.status(404).send({ message: "That tour guide is no longer available." });

        const duplicate = await bookingsCollection.findOne({
          packageId,
          touristEmail: req.user.email,
          payment_status: "not_paid",
          status: { $nin: ["cancelled", "rejected"] },
        });
        if (duplicate) {
          return res.status(409).send({
            message: "You already have an unpaid booking for this trip. Finish or cancel it from My bookings.",
            bookingId: duplicate._id,
          });
        }

        const guideBusy = await bookingsCollection.findOne({
          tourGuideEmail,
          tourDay,
          status: { $in: ["in review", "accepted"] },
        });
        if (guideBusy) {
          return res.status(409).send({ message: "That guide is already booked on this date. Pick another date or guide." });
        }

        const result = await bookingsCollection.insertOne({
          packageId,
          packageName: pkg.title,
          packageImage: pkg.images?.[0] || "",
          location: pkg.location,
          price: Number(pkg.price),
          durationDays: pkg.tourPlan?.length || 1,
          tourDate: tourDate.toISOString(),
          tourDay,
          touristEmail: req.user.email,
          touristName: tourist?.name || str(body.touristName, 80),
          touristImage: tourist?.photo || str(body.touristImage),
          tourGuideEmail,
          tourGuideName: guide.guideInfo?.name || guide.name,
          tourGuideImage: guide.guideInfo?.photo || guide.photo || "",
          status: "pending",
          payment_status: "not_paid",
          bookingAt: nowISO(),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Something went wrong while processing your booking." });
      }
    });

    app.patch("/bookings/:id", verifyJwt, async (req, res) => {
      try {
        if (req.user.role !== "tourist" && req.user.role !== "tour guide") {
          return res.status(403).send({ message: "Forbidden: Tourists and tour guides only" });
        }
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const status = str(req.body?.status, 20);
        if (!["accepted", "rejected", "cancelled"].includes(status)) {
          return res.status(400).send({ message: "Status must be accepted, rejected or cancelled." });
        }

        const booking = await bookingsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!booking) return res.status(404).send({ message: "Booking not found" });

        const isOwner = booking.touristEmail === req.user.email;
        const isGuide = booking.tourGuideEmail === req.user.email && req.user.role === "tour guide";
        if (!isOwner && !isGuide) {
          return res.status(403).send({ message: "Forbidden: Not your booking" });
        }

        const open = ["pending", "in review"];
        const allowed =
          (status === "cancelled" && isOwner && open.includes(booking.status)) ||
          (status === "accepted" && isGuide && booking.status === "in review") ||
          (status === "rejected" && isGuide && open.includes(booking.status));
        if (!allowed) {
          return res.status(409).send({
            message: `This booking is ${booking.status}, so it can't be marked ${status} by you.`,
          });
        }

        const update = { status, updatedAt: nowISO() };

        // Closing a paid booking returns the money before anything else changes.
        if ((status === "cancelled" || status === "rejected") && booking.payment_status === "paid") {
          const payment = await paymentsCollection.findOne({ bookingId: String(booking._id) });
          if (payment && !payment.refunded) {
            try {
              await stripe.refunds.create({ payment_intent: payment.transactionId });
            } catch (error) {
              return res.status(502).send({
                message: `The refund could not be processed (${error.message}). The booking was not changed.`,
              });
            }
            await paymentsCollection.updateOne(
              { _id: payment._id },
              { $set: { refunded: true, refundedAt: nowISO() } },
            );
          }
          update.payment_status = "refunded";
        }

        const result = await bookingsCollection.updateOne(
          { _id: booking._id, status: booking.status },
          { $set: update },
        );
        if (result.matchedCount === 0) {
          return res.status(409).send({ message: "This booking just changed. Refresh and try again." });
        }

        res.send({ message: "Booking status updated", modifiedCount: result.modifiedCount });
      } catch (error) {
        res.status(500).send({ message: "Failed to update booking status", error: error.message });
      }
    });

    /* ---------------------------------------------------------------- */
    /*  Payments (the server decides the amount, not the browser)       */
    /* ---------------------------------------------------------------- */
    const loadPayableBooking = async (bookingId, email) => {
      if (!isId(bookingId)) return { error: [400, "A valid booking is required."] };
      const booking = await bookingsCollection.findOne({ _id: new ObjectId(bookingId) });
      if (!booking) return { error: [404, "Booking not found."] };
      if (booking.touristEmail !== email) return { error: [403, "Forbidden: Not your booking"] };
      if (booking.status !== "pending" || booking.payment_status !== "not_paid") {
        return { error: [409, "This booking can't be paid for."] };
      }
      return { booking };
    };

    app.post("/create-payment-intent", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const { booking, error } = await loadPayableBooking(req.body?.bookingId, req.user.email);
        if (error) return res.status(error[0]).send({ message: error[1] });

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(Number(booking.price) * 100),
          currency: "bdt",
          payment_method_types: ["card"],
          metadata: { bookingId: String(booking._id), email: req.user.email },
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.post("/payments", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const { bookingId, transactionId } = req.body || {};
        const { booking, error } = await loadPayableBooking(bookingId, req.user.email);
        if (error) return res.status(error[0]).send({ message: error[1] });
        if (typeof transactionId !== "string" || !transactionId) {
          return res.status(400).send({ message: "A transaction id is required." });
        }

        // Trust Stripe, not the browser.
        const intent = await stripe.paymentIntents.retrieve(transactionId);
        if (
          intent.status !== "succeeded" ||
          intent.amount !== Math.round(Number(booking.price) * 100) ||
          intent.metadata?.bookingId !== String(booking._id)
        ) {
          return res.status(400).send({ message: "We couldn't verify this payment with Stripe." });
        }

        const used = await paymentsCollection.findOne({ transactionId });
        if (used) return res.status(409).send({ message: "This payment was already recorded." });

        const result = await paymentsCollection.insertOne({
          bookingId: String(booking._id),
          email: req.user.email,
          price: Number(booking.price),
          transactionId,
          paymentMethod: intent.payment_method_types || ["card"],
          paymentAt: nowISO(),
        });

        const update = await bookingsCollection.updateOne(
          { _id: booking._id, payment_status: "not_paid" },
          { $set: { status: "in review", payment_status: "paid", updatedAt: nowISO() } },
        );

        res.send({ insertedId: result.insertedId, updatedBooking: update.modifiedCount > 0 });
      } catch (error) {
        res.status(500).send({ message: "Failed to process payment", error: error.message });
      }
    });

    /* ---------------------------------------------------------------- */
    /*  Stories                                                         */
    /* ---------------------------------------------------------------- */
    app.get("/random-stories", async (req, res) => {
      try {
        res.send(await storiesCollection.aggregate([{ $sample: { size: 3 } }]).toArray());
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch random stories", error: error.message });
      }
    });

    app.get("/stories", async (req, res) => {
      try {
        const page = toInt(req.query.page, 1, 1, 100000);
        const limit = 12;
        const email = str(req.query.email, 200);
        const search = str(req.query.search, 100);

        const query = {};
        if (email) query.email = email;
        if (search) {
          const regex = new RegExp(escapeRegex(search), "i");
          query.$or = [{ title: regex }, { location: regex }];
        }

        const [total, stories] = await Promise.all([
          storiesCollection.countDocuments(query),
          storiesCollection
            .find(query)
            .sort({ uploadedAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        ]);

        res.send({ total, limit, stories });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch stories", error: error.message });
      }
    });

    app.get("/stories/:id", async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const story = await storiesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!story) return res.status(404).send({ message: "Story not found" });
        res.send(story);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch story", error: error.message });
      }
    });

    app.post("/stories", verifyJwt, async (req, res) => {
      try {
        const body = req.body || {};
        const author = await usersCollection.findOne({ email: req.user.email });
        const images = Array.isArray(body.images) ? body.images.map((i) => str(i)).filter(Boolean).slice(0, 10) : [];

        const story = {
          title: str(body.title, 150),
          description: str(body.description, 10000),
          location: str(body.location, 120),
          images,
          name: author?.name || str(body.name, 80),
          email: req.user.email,
          photo: author?.photo || str(body.photo),
          role: req.user.role,
          uploadedAt: nowISO(),
        };

        if (!story.title || !story.description || !story.location || !images.length || !story.name) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        res.send(await storiesCollection.insertOne(story));
      } catch (error) {
        res.status(500).send({ message: "Failed to add story", error: error.message });
      }
    });

    app.patch("/stories/:id", verifyJwt, async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const query = { _id: new ObjectId(req.params.id) };
        const story = await storiesCollection.findOne(query);
        if (!story) return res.status(404).send({ message: "Story not found" });
        if (story.email !== req.user.email) {
          return res.status(403).send({ message: "Forbidden: You can only edit your own stories" });
        }

        const body = req.body || {};
        const remove = Array.isArray(body.imagesToRemove) ? body.imagesToRemove.map((i) => str(i)) : [];
        const add = Array.isArray(body.imagesToAdd) ? body.imagesToAdd.map((i) => str(i)).filter(Boolean) : [];
        const images = [...(story.images || []).filter((img) => !remove.includes(img)), ...add].slice(0, 10);

        const title = str(body.title, 150);
        const description = str(body.description, 10000);
        const location = str(body.location, 120);
        if (!title || !description || !location || !images.length) {
          return res.status(400).send({ message: "Title, story, location and at least one photo are required." });
        }

        await storiesCollection.updateOne(query, {
          $set: { title, description, location, images, updatedAt: nowISO() },
        });
        res.send({ success: true, message: "Story updated successfully" });
      } catch (error) {
        res.status(500).send({ message: "Failed to update story", error: error.message });
      }
    });

    app.delete("/stories/:id", verifyJwt, async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.status(400).send({ message: "Invalid id" });
        const query = { _id: new ObjectId(req.params.id) };
        const story = await storiesCollection.findOne(query);
        if (!story) return res.status(404).send({ message: "Story not found" });
        if (story.email !== req.user.email && req.user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden: You can only delete your own stories" });
        }
        res.send(await storiesCollection.deleteOne(query));
      } catch (error) {
        res.status(500).send({ message: "Failed to delete story.", error: error.message });
      }
    });

    /* ---------------------------------------------------------------- */
    /*  Stats                                                           */
    /* ---------------------------------------------------------------- */
    app.get("/stats/public", async (req, res) => {
      try {
        const [tourists, guides, packages, stories] = await Promise.all([
          usersCollection.countDocuments({ role: "tourist" }),
          usersCollection.countDocuments({ role: "tour guide" }),
          packagesCollection.countDocuments(),
          storiesCollection.countDocuments(),
        ]);
        res.send({ tourists, guides, packages, stories });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get("/admin/stats", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const kept = { refunded: { $ne: true } };

        const [
          revenue,
          payments,
          totalTourGuides,
          totalClients,
          totalPackages,
          totalStories,
          totalBookings,
          pendingApplications,
          statusGroups,
          recentBookings,
          recentUsers,
          topPackages,
        ] = await Promise.all([
          paymentsCollection.aggregate([{ $match: kept }, { $group: { _id: null, total: { $sum: "$price" } } }]).toArray(),
          paymentsCollection.find(kept, { projection: { price: 1, paymentAt: 1 } }).toArray(),
          usersCollection.countDocuments({ role: "tour guide" }),
          usersCollection.countDocuments({ role: "tourist" }),
          packagesCollection.countDocuments(),
          storiesCollection.countDocuments(),
          bookingsCollection.countDocuments(),
          applicationsCollection.countDocuments({ status: "pending" }),
          bookingsCollection.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
          bookingsCollection.find().sort({ bookingAt: -1 }).limit(5).toArray(),
          usersCollection
            .find({}, { projection: { name: 1, email: 1, role: 1, photo: 1, createdAt: 1, created_at: 1 } })
            .sort({ _id: -1 })
            .limit(5)
            .toArray(),
          bookingsCollection
            .aggregate([
              { $match: { status: { $nin: ["cancelled", "rejected"] } } },
              { $group: { _id: "$packageName", bookings: { $sum: 1 } } },
              { $sort: { bookings: -1 } },
              { $limit: 5 },
            ])
            .toArray(),
        ]);

        const statusLabels = [
          ["pending", "Awaiting payment"],
          ["in review", "In review"],
          ["accepted", "Confirmed"],
          ["rejected", "Declined"],
          ["cancelled", "Cancelled"],
        ];
        const statusMap = Object.fromEntries(statusGroups.map((g) => [g._id, g.count]));

        res.send({
          totalPayments: revenue[0]?.total || 0,
          paymentsTrend: sumByMonth(payments, (p) => p.paymentAt, (p) => p.price).map((m) => ({
            month: m.month,
            payments: m.value,
          })),
          totalTourGuides,
          totalClients,
          totalPackages,
          totalStories,
          totalBookings,
          pendingApplications,
          bookingStatus: statusLabels.map(([key, name]) => ({ name, value: statusMap[key] || 0 })),
          recentBookings,
          recentUsers: recentUsers.map((u) => ({ ...u, createdAt: u.createdAt || u.created_at })),
          topPackages: topPackages.map((p) => ({ package: p._id, bookings: p.bookings })),
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/tourist/stats", verifyJwt, verifyTourist, async (req, res) => {
      try {
        const email = req.user.email;
        const bookings = await bookingsCollection.find({ touristEmail: email }).sort({ bookingAt: -1 }).toArray();

        const paid = bookings.filter((b) => b.payment_status === "paid");
        const completed = bookings.filter(isCompleted);
        const upcoming = bookings.filter(isUpcoming);
        const awaiting = bookings.filter((b) => b.status === "pending");

        const perPackage = {};
        paid.forEach((b) => {
          perPackage[b.packageName] = (perPackage[b.packageName] || 0) + Number(b.price);
        });

        res.send({
          stats: {
            totalBookings: bookings.length,
            upcomingTours: upcoming.length,
            completedTours: completed.length,
            cancelledTours: bookings.filter((b) => b.status === "cancelled").length,
            rejectedTours: bookings.filter((b) => b.status === "rejected").length,
            pendingPayments: awaiting.length,
            totalSpent: paid.reduce((sum, b) => sum + Number(b.price), 0),
          },
          monthlySpending: sumByMonth(paid, (b) => b.updatedAt || b.bookingAt, (b) => Number(b.price)).map((m) => ({
            month: m.month,
            total: m.value,
          })),
          spentPerPackage: Object.entries(perPackage)
            .map(([name, spent]) => ({ package: name, spent }))
            .sort((a, b) => b.spent - a.spent)
            .slice(0, 5),
          tourDistribution: [
            { name: "Upcoming", value: upcoming.length },
            { name: "Completed", value: completed.length },
            { name: "Awaiting payment", value: awaiting.length },
            { name: "Cancelled", value: bookings.filter((b) => b.status === "cancelled").length },
            { name: "Declined", value: bookings.filter((b) => b.status === "rejected").length },
          ],
          nextTrips: [...upcoming].sort((a, b) => new Date(a.tourDate) - new Date(b.tourDate)).slice(0, 3),
          awaitingPayment: awaiting.slice(0, 3),
          recentBookings: bookings.slice(0, 5),
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/tourGuide/stats", verifyJwt, verifyTourGuide, async (req, res) => {
      try {
        const bookings = await bookingsCollection
          .find({ tourGuideEmail: req.user.email, status: { $ne: "cancelled" } })
          .sort({ bookingAt: -1 })
          .toArray();

        const confirmedOrReview = bookings.filter((b) => b.status === "accepted" || b.status === "in review");
        const completed = bookings.filter(isCompleted);
        const upcoming = bookings.filter(isUpcoming);
        const inReview = bookings.filter((b) => b.status === "in review");
        const rejected = bookings.filter((b) => b.status === "rejected");
        const accepted = bookings.filter((b) => b.status === "accepted");

        const perPackage = {};
        confirmedOrReview.forEach((b) => {
          perPackage[b.packageName] = (perPackage[b.packageName] || 0) + 1;
        });

        res.send({
          stats: {
            totalBookings: bookings.length,
            upcomingTours: upcoming.length,
            completedTours: completed.length,
            rejectedTours: rejected.length,
            awaitingResponse: inReview.length,
            earnings: accepted.reduce((sum, b) => sum + Number(b.price), 0),
          },
          tourDistribution: [
            { name: "Upcoming", value: upcoming.length - inReview.length },
            { name: "Completed", value: completed.length },
            { name: "In review", value: inReview.length },
            { name: "Declined", value: rejected.length },
          ],
          toursPerPackage: Object.entries(perPackage)
            .map(([name, count]) => ({ package: name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5),
          monthlyTours: sumByMonth(confirmedOrReview, (b) => b.tourDate, () => 1).map((m) => ({
            month: m.month,
            count: m.value,
          })),
          requests: inReview.sort((a, b) => new Date(a.bookingAt) - new Date(b.bookingAt)).slice(0, 5),
          nextTours: accepted
            .filter((b) => !isCompleted(b))
            .sort((a, b) => new Date(a.tourDate) - new Date(b.tourDate))
            .slice(0, 3),
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`TourNest API running on port ${port}`);
});
