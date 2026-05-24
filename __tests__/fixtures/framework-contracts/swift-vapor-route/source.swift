import Vapor

func routes(_ app: Application) throws {
    app.get("users", use: listUsers)
}
