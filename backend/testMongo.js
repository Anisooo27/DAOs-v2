const { MongoClient } = require("mongodb");

const uri = "mongodb+srv://aniszahaf2746_db_user:Azert123456789@daos.louuzw6.mongodb.net/DAOs?retryWrites=true&w=majority&appName=DAOs";

async function run() {
    try {
        const client = new MongoClient(uri);
        await client.connect();
        console.log("✅ Connected to MongoDB!");
        await client.close();
    } catch (err) {
        console.error("❌ Connection failed:", err);
    }
}

run();
