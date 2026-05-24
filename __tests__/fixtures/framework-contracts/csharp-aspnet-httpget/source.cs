using Microsoft.AspNetCore.Mvc;

namespace Demo.Controllers;

public class UserController : ControllerBase
{
    [HttpGet("/users")]
    public IActionResult ListUsers()
    {
        return Ok();
    }
}
